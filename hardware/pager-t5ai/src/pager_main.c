/**
 * @file pager_main.c
 * @brief SRE pager firmware for the Tuya T5AI-Core devkit (TuyaOpen).
 *
 * The board long-polls the pager Worker (GET /v1/device/state?v=..&wait=20) with its device token. While an
 * incident pages its owner it flashes the LED and sounds a siren; a press of the button acknowledges every
 * page (POST /v1/device/ack); holding it for two seconds snoozes them for 30 minutes instead (POST
 * /v1/device/snooze). A board that has lost the server for 5 minutes chirps once a minute: a pager that cannot be
 * reached must not look like one with nothing to say. Settings live in flash and are set over the serial console:
 *
 *   pager_wifi <ssid> [password]
 *   pager_url  http://192.168.1.20:8787  |  https://pager.example.com
 *   pager_token dev_xxxxxxxx
 *   pager_voice http://192.168.1.20:8790 <voice token>  |  pager_voice off
 *   pager_show       pager_test       pager_reboot
 *   pager_audio      ring for 2 s and report what the microphone heard
 *   pager_clear      forget the server and token; the board goes quiet until it is set up again
 *
 * Voice mode (pager_voice, the service in voice/): a new page is read out between siren cycles, and again every
 * minute while it rings. Holding the button records until it is released and the words decide: "收到" / "ack"
 * acknowledges, "二十分钟后" / "snooze 20 minutes" snoozes, "已解决" / "resolved" resolves the incident the board
 * announced, "再说一遍" / "repeat" reads it again. A rising chirp means done; two low ones mean not understood, and
 * the page rings again. The microphone is only kept while the button is held. When the voice service cannot be
 * reached the hold means what it always did, a 30-minute snooze, and the siren never waits for speech.
 *
 * LED: off = all clear · solid = acknowledged incidents still open · fast blink = PAGING ·
 *      slow blink = not configured / no Wi-Fi / server unreachable.
 *
 * @copyright Apache-2.0
 */

#include "tuya_cloud_types.h"

#include "cJSON.h"
#include "http_client_interface.h"
#include "netmgr.h"
#include "tal_api.h"
#include "tal_cli.h"
#include "tkl_gpio.h"
#include "tkl_output.h"
#if defined(ENABLE_WIFI) && (ENABLE_WIFI == 1)
#include "netconn_wifi.h"
#endif

#include "board_com_api.h"
#include "tdd_audio.h"
#include "tdl_audio_manage.h"
#include "tdl_button_manage.h"
#include "tdl_led_manage.h"

/***********************************************************
************************ macro define **********************
***********************************************************/
#define FW_VERSION "pager-t5ai/" PROJECT_VERSION

#define KV_SSID  "pg.ssid"
#define KV_PSWD  "pg.pswd"
#define KV_URL   "pg.url"
#define KV_TOKEN "pg.token"
#define KV_VURL  "pg.vurl"
#define KV_VTOK  "pg.vtok"

#define LONG_POLL_S       20
/* TuyaOpen gives a plain TCP read 5 s whatever the request asks for; only TLS honours the timeout. */
#define LONG_POLL_PLAIN_S 3
#define HTTP_TIMEOUT_MS   ((LONG_POLL_S + 10) * 1000)
#define BACKOFF_MAX_MS    30000
#define SAMPLE_RATE       16000
#define SIREN_VOLUME      80
#define PAGER_AUDIO_NAME  "pager_audio"
#define SPK_EN_PIN        TUYA_GPIO_NUM_39 // amplifier enable on the T5AI-Core: high = on
#define TEST_TONE_HZ      1000
#define GOERTZEL_COEFF    1.847759f // 2*cos(2*pi*1000/16000), for TEST_TONE_HZ at SAMPLE_RATE
#define SNOOZE_MIN        30
#define OFFLINE_CHIRP_AFTER_MS (5 * 60 * 1000)
#define OFFLINE_CHIRP_EVERY_MS (60 * 1000)

#define HOLD_MS          2000 // a long press: snooze
#define VOICE_HOLD_MS    800  // with voice on, a hold this long is speech (a quick "收到" is shorter than 2 s)
#define REC_MAX_BYTES    (6 * SAMPLE_RATE * 2)  // the most a hold records; voice/ takes up to 8 s
#define SAY_MAX_BYTES    (10 * SAMPLE_RATE * 2) // the longest announcement kept, as voice/ caps it
#define VOICE_TIMEOUT_MS 15000
#define VOICE_REPEAT_MS  60000 // read the page out again while it still rings
#define CHIRP_OK 1
#define CHIRP_NO 2

/* Speech and recordings are large: in PSRAM when the board has it. */
#if defined(ENABLE_EXT_RAM) && (ENABLE_EXT_RAM == 1)
#define VOICE_MALLOC tal_psram_malloc
#define VOICE_FREE   tal_psram_free
#else
#define VOICE_MALLOC tal_malloc
#define VOICE_FREE   tal_free
#endif

extern const char PAGER_CA_BUNDLE[];
extern const size_t PAGER_CA_BUNDLE_LEN;

/***********************************************************
*********************** typedef define *********************
***********************************************************/
typedef enum {
    LINK_UNCONFIGURED = 0, // no Wi-Fi / URL / token yet
    LINK_OFFLINE,          // Wi-Fi down or server unreachable
    LINK_ONLINE,
} LINK_STATE_E;

typedef struct {
    char ssid[33];
    char pswd[65];
    char url[160];
    char token[96];
    /* parsed from url */
    char host[128];
    uint16_t port;
    bool tls;
    /* the voice service (voice/), optional */
    char vurl[160];
    char vtoken[96];
    char vhost[128];
    uint16_t vport;
    bool vtls;
} PAGER_CFG_T;

typedef enum {
    ACT_ACK = 0,
    ACT_SNOOZE,
    ACT_RESOLVE,
} ACTION_E;

typedef struct {
    LINK_STATE_E link;
    bool alert;      // unacknowledged pages for this device's user
    int count;       // how many
    int acked;       // acknowledged, still open
    char severity[12];
    char title[128];
    char service[48];
    char top_id[40];
    char last_id[40]; // the last real incident that paged here: what a spoken "resolved" closes
    int number;
    double version;  // server change counter we last saw
    bool muted;      // the button was pressed; silence until the server confirms or a new page arrives
} PAGER_STATE_T;

/***********************************************************
********************** variable define *********************
***********************************************************/
static PAGER_CFG_T sg_cfg;
static PAGER_STATE_T sg_st;
static MUTEX_HANDLE sg_mutex;
static SEM_HANDLE sg_ack_sem;
static SEM_HANDLE sg_wake_sem; // nudges the poller (new config, ack done)
static volatile bool sg_net_up = false;
static volatile bool sg_test_ring = false;
/* What the next post of sg_ack_sem asks for; a button tap leaves it at ACT_ACK. */
static volatile int sg_action = ACT_ACK;
static volatile int sg_snooze_min = SNOOZE_MIN;
static volatile bool sg_action_voice = false; // spoken: confirm with a chirp
static volatile bool sg_mic_open = false;      // __mic_cb is adding up a measurement
static volatile uint32_t sg_test_tone = 0;    // the alarm thread plays this frequency while it is non-zero
static uint64_t sg_mic_tone;
static uint32_t sg_mic_peak, sg_mic_frames;
static volatile uint32_t sg_play_errors = 0;

static TDL_LED_HANDLE_T sg_led;
static TDL_AUDIO_HANDLE_T sg_audio;
static TDL_AUDIO_INFO_T sg_audio_info;

static THREAD_HANDLE sg_poll_thrd, sg_alarm_thrd, sg_ack_thrd, sg_voice_thrd;

/* Voice. The voice thread fetches speech into sg_say_next; only the alarm thread plays it, moving it to sg_say_cur
   and freeing the one before, so a buffer is never freed while it plays. */
static SEM_HANDLE sg_voice_sem;
static volatile bool sg_say_wanted = false;  // fetch the announcement of the current page
static volatile bool sg_hear_wanted = false; // send the recording
static volatile bool sg_say_pending = false; // a new announcement is waiting to be played
static volatile bool sg_say_again = false;   // play the current one again
static volatile int sg_chirp = 0;
static uint8_t *sg_say_next, *sg_say_cur; // sg_say_next under sg_mutex; sg_say_cur alarm thread only
static uint32_t sg_say_next_len, sg_say_cur_len;
static int sg_say_next_num = -1, sg_say_cur_num = -1; // the incident number each one announces
static uint8_t *sg_rec_buf;
static volatile uint32_t sg_rec_len = 0;
static volatile bool sg_rec_on = false;   // the button is down and __mic_cb keeps what it hears
static volatile bool sg_rec_long = false; // the press became a hold: send it when released

/* A quarter of a sine wave, 0..32767, 16 steps; the rest is mirrored. */
static const int16_t SINE_Q[17] = {0,     3212,  6393,  9512,  12539, 15446, 18204, 20787, 23170,
                                   25329, 27245, 28898, 30273, 31356, 32137, 32609, 32767};

/***********************************************************
*********************** config storage *********************
***********************************************************/
static void __kv_read(const char *key, char *out, size_t cap)
{
    uint8_t *val = NULL;
    size_t len = 0;
    out[0] = '\0';
    if (tal_kv_get(key, &val, &len) == OPRT_OK && val) {
        size_t n = len < cap - 1 ? len : cap - 1;
        memcpy(out, val, n);
        out[n] = '\0';
        tal_kv_free(val);
    }
}

static void __kv_write(const char *key, const char *val)
{
    tal_kv_set(key, (const uint8_t *)val, strlen(val));
}

/** "https://host[:port][/...]" → host, port, tls. Returns false when the URL is unusable. */
static bool __parse_url_to(const char *url, char *host, size_t cap, uint16_t *port, bool *tls)
{
    const char *p = url;
    if (strncmp(p, "https://", 8) == 0) {
        *tls = true;
        *port = 443;
        p += 8;
    } else if (strncmp(p, "http://", 7) == 0) {
        *tls = false;
        *port = 80;
        p += 7;
    } else {
        return false;
    }
    size_t i = 0;
    while (*p && *p != ':' && *p != '/' && i < cap - 1) {
        host[i++] = *p++;
    }
    host[i] = '\0';
    if (*p == ':') {
        *port = (uint16_t)atoi(p + 1);
    }
    return i > 0 && *port > 0;
}

static bool __parse_url(PAGER_CFG_T *c)
{
    return __parse_url_to(c->url, c->host, sizeof(c->host), &c->port, &c->tls);
}

static void __load_cfg(void)
{
    tal_mutex_lock(sg_mutex);
    __kv_read(KV_SSID, sg_cfg.ssid, sizeof(sg_cfg.ssid));
    __kv_read(KV_PSWD, sg_cfg.pswd, sizeof(sg_cfg.pswd));
    __kv_read(KV_URL, sg_cfg.url, sizeof(sg_cfg.url));
    __kv_read(KV_TOKEN, sg_cfg.token, sizeof(sg_cfg.token));
    if (!__parse_url(&sg_cfg)) {
        sg_cfg.host[0] = '\0';
    }
    __kv_read(KV_VURL, sg_cfg.vurl, sizeof(sg_cfg.vurl));
    __kv_read(KV_VTOK, sg_cfg.vtoken, sizeof(sg_cfg.vtoken));
    if (!__parse_url_to(sg_cfg.vurl, sg_cfg.vhost, sizeof(sg_cfg.vhost), &sg_cfg.vport, &sg_cfg.vtls)) {
        sg_cfg.vhost[0] = '\0';
    }
    tal_mutex_unlock(sg_mutex);
}

static bool __configured(void)
{
    return sg_cfg.host[0] && sg_cfg.token[0];
}

static bool __voice_configured(void)
{
    return sg_cfg.vhost[0] && sg_cfg.vtoken[0];
}

/** Voice is set up and the board can play and record. */
static bool __voice_on(void)
{
    return __voice_configured() && sg_audio && sg_rec_buf;
}

static void __wifi_connect(void)
{
#if defined(ENABLE_WIFI) && (ENABLE_WIFI == 1)
    if (!sg_cfg.ssid[0]) {
        PR_WARN("no Wi-Fi configured: pager_wifi <ssid> [password]");
        return;
    }
    netconn_wifi_info_t wifi_info = {0};
    strncpy(wifi_info.ssid, sg_cfg.ssid, sizeof(wifi_info.ssid) - 1);
    strncpy(wifi_info.pswd, sg_cfg.pswd, sizeof(wifi_info.pswd) - 1);
    PR_NOTICE("connecting to Wi-Fi \"%s\"", sg_cfg.ssid);
    netmgr_conn_set(NETCONN_WIFI, NETCONN_CMD_SSID_PSWD, &wifi_info);
#endif
}

/***********************************************************
************************ HTTP client ***********************
***********************************************************/
/** One HTTP request. Returns the status, or -1 when nothing came back; the caller frees *resp with http_client_free. */
static int __http(const char *host, uint16_t port, bool tls, const char *method, const char *path, const char *auth,
                  const char *content_type, const uint8_t *body, size_t body_len, uint32_t timeout_ms,
                  http_client_response_t *resp)
{
    http_client_header_t headers[] = {
        {.key = "Authorization", .value = auth},
        {.key = "X-Firmware", .value = FW_VERSION},
        {.key = "Content-Type", .value = content_type},
    };
    http_client_status_t st = http_client_request(
        &(const http_client_request_t){
            .cacert = tls ? (const uint8_t *)PAGER_CA_BUNDLE : NULL,
            .cacert_len = tls ? PAGER_CA_BUNDLE_LEN : 0,
            .host = host,
            .port = port,
            .method = method,
            .path = path,
            .headers = headers,
            .headers_count = sizeof(headers) / sizeof(headers[0]),
            .body = body ? body : (const uint8_t *)"",
            .body_length = body ? body_len : 0,
            .timeout_ms = timeout_ms,
        },
        resp);
    if (st != HTTP_CLIENT_SUCCESS) {
        PR_ERR("%s %s%s: http error %d", method, host, path, st);
        return -1;
    }
    return resp->status_code;
}

/** One request to the pager server. On success *body (caller frees with cJSON_Delete) holds the parsed JSON. */
static int __pager_request(const char *method, const char *path, uint32_t timeout_ms, cJSON **body)
{
    char auth[112], host[128];
    uint16_t port;
    bool tls;

    tal_mutex_lock(sg_mutex);
    snprintf(auth, sizeof(auth), "Device %s", sg_cfg.token);
    strcpy(host, sg_cfg.host);
    port = sg_cfg.port;
    tls = sg_cfg.tls;
    tal_mutex_unlock(sg_mutex);

    http_client_response_t resp = {0};
    int status = __http(host, port, tls, method, path, auth, "application/json", NULL, 0, timeout_ms, &resp);
    if (status >= 0) {
        if (body) {
            *body = (resp.body && resp.body_length) ? cJSON_ParseWithLength((const char *)resp.body, resp.body_length) : NULL;
        }
        if (status != 200) {
            PR_ERR("%s %s: HTTP %d %.*s", method, path, status, (int)(resp.body_length > 120 ? 120 : resp.body_length),
                   resp.body ? (const char *)resp.body : "");
        }
    }
    http_client_free(&resp);
    return status;
}

/** One POST to the voice service; the caller frees *resp with http_client_free. */
static int __voice_request(const char *path, const char *content_type, const uint8_t *body, size_t len,
                           http_client_response_t *resp)
{
    char auth[112], host[128];
    uint16_t port;
    bool tls;

    tal_mutex_lock(sg_mutex);
    snprintf(auth, sizeof(auth), "Voice %s", sg_cfg.vtoken);
    strcpy(host, sg_cfg.vhost);
    port = sg_cfg.vport;
    tls = sg_cfg.vtls;
    tal_mutex_unlock(sg_mutex);

    if (!host[0] || !sg_net_up) return -1;
    int status = __http(host, port, tls, "POST", path, auth, content_type, body, len, VOICE_TIMEOUT_MS, resp);
    if (status >= 0 && status != 200) PR_ERR("voice %s: HTTP %d", path, status);
    return status;
}

static void __apply_state(cJSON *j)
{
    cJSON *v = cJSON_GetObjectItem(j, "v");
    cJSON *alert = cJSON_GetObjectItem(j, "alert");
    cJSON *count = cJSON_GetObjectItem(j, "count");
    cJSON *acked = cJSON_GetObjectItem(j, "acked");
    cJSON *top = cJSON_GetObjectItem(j, "top");

    tal_mutex_lock(sg_mutex);
    int prev_count = sg_st.count;
    bool prev_alert = sg_st.alert;
    if (cJSON_IsNumber(v)) sg_st.version = v->valuedouble;
    sg_st.alert = cJSON_IsNumber(alert) && alert->valueint;
    sg_st.count = cJSON_IsNumber(count) ? count->valueint : 0;
    sg_st.acked = cJSON_IsNumber(acked) ? acked->valueint : 0;
    sg_st.title[0] = sg_st.severity[0] = sg_st.service[0] = sg_st.top_id[0] = '\0';
    sg_st.number = 0;
    if (cJSON_IsObject(top)) {
        cJSON *t = cJSON_GetObjectItem(top, "title");
        cJSON *s = cJSON_GetObjectItem(top, "severity");
        cJSON *n = cJSON_GetObjectItem(top, "number");
        cJSON *svc = cJSON_GetObjectItem(top, "service");
        cJSON *id = cJSON_GetObjectItem(top, "id");
        if (cJSON_IsString(t)) strncpy(sg_st.title, t->valuestring, sizeof(sg_st.title) - 1);
        if (cJSON_IsString(s)) strncpy(sg_st.severity, s->valuestring, sizeof(sg_st.severity) - 1);
        if (cJSON_IsNumber(n)) sg_st.number = n->valueint;
        if (cJSON_IsString(svc)) strncpy(sg_st.service, svc->valuestring, sizeof(sg_st.service) - 1);
        if (cJSON_IsString(id)) strncpy(sg_st.top_id, id->valuestring, sizeof(sg_st.top_id) - 1);
    }
    /* Kept after an acknowledgement, so "resolved" can still name it; forgotten once nothing is open here. */
    if (sg_st.top_id[0] && strcmp(sg_st.top_id, "test") != 0) {
        memcpy(sg_st.last_id, sg_st.top_id, sizeof(sg_st.last_id));
    } else if (!sg_st.alert && !sg_st.acked) {
        sg_st.last_id[0] = '\0';
    }
    /* Muting lasts until the pages are gone or a new one arrives. */
    if (!sg_st.alert || sg_st.count > prev_count) sg_st.muted = false;
    sg_st.link = LINK_ONLINE;
    bool newly = sg_st.alert && (!prev_alert || sg_st.count > prev_count);
    tal_mutex_unlock(sg_mutex);

    if (newly) {
        PR_NOTICE(">>> PAGE #%d [%s] %s (%d unacknowledged)", sg_st.number, sg_st.severity, sg_st.title, sg_st.count);
        if (__voice_on()) {
            sg_say_wanted = true;
            tal_semaphore_post(sg_voice_sem);
        }
    }
}

/***********************************************************
************************** threads *************************
***********************************************************/
/** Long-polls the server for this device's state. */
static void __poll_task(void *arg)
{
    uint32_t backoff = 1000;
    char path[96];
    (void)arg;

    for (;;) {
        if (!__configured()) {
            sg_st.link = LINK_UNCONFIGURED;
            tal_semaphore_wait(sg_wake_sem, 5000);
            continue;
        }
        if (!sg_net_up) {
            sg_st.link = LINK_OFFLINE;
            tal_semaphore_wait(sg_wake_sem, 2000);
            continue;
        }

        if (sg_st.version > 0) {
            snprintf(path, sizeof(path), "/v1/device/state?v=%.0f&wait=%d", sg_st.version,
                     sg_cfg.tls ? LONG_POLL_S : LONG_POLL_PLAIN_S);
        } else {
            snprintf(path, sizeof(path), "/v1/device/state");
        }
        cJSON *j = NULL;
        int status = __pager_request("GET", path, HTTP_TIMEOUT_MS, &j);
        if (status == 200 && j) {
            __apply_state(j);
            backoff = 1000;
        } else {
            sg_st.link = LINK_OFFLINE;
            if (status == 401) PR_ERR("device token rejected: set a new one with pager_token");
            PR_WARN("retrying in %u ms", backoff);
            tal_semaphore_wait(sg_wake_sem, backoff);
            backoff = backoff * 2 > BACKOFF_MAX_MS ? BACKOFF_MAX_MS : backoff * 2;
        }
        if (j) cJSON_Delete(j);
    }
}

static void __unmute(void)
{
    tal_mutex_lock(sg_mutex);
    sg_st.muted = false;
    tal_mutex_unlock(sg_mutex);
}

/** Asks the ack thread to act: the button's tap and hold, and what voice heard. */
static void __act(ACTION_E action, int minutes, bool voice)
{
    sg_action = action;
    sg_snooze_min = minutes;
    sg_action_voice = voice;
    tal_semaphore_post(sg_ack_sem);
}

/** Sends acknowledgements, snoozes and resolutions when the button or voice asks for one. */
static void __ack_task(void *arg)
{
    char path[96];
    (void)arg;
    for (;;) {
        tal_semaphore_wait_forever(sg_ack_sem);
        int action = sg_action;
        int minutes = sg_snooze_min;
        bool voice = sg_action_voice;
        sg_action = ACT_ACK;
        sg_snooze_min = SNOOZE_MIN;
        sg_action_voice = false;

        const char *done = "acknowledged";
        path[0] = '\0';
        if (action == ACT_SNOOZE) {
            snprintf(path, sizeof(path), "/v1/device/snooze?minutes=%d", minutes);
            done = "snoozed";
        } else if (action == ACT_RESOLVE) {
            tal_mutex_lock(sg_mutex);
            if (sg_st.last_id[0]) snprintf(path, sizeof(path), "/v1/device/resolve?id=%s", sg_st.last_id);
            tal_mutex_unlock(sg_mutex);
            done = "resolved";
        } else {
            strcpy(path, "/v1/device/ack");
        }

        cJSON *j = NULL;
        /* No network means the press reached nobody: fall through and ring again, or the page is silently lost. */
        int status = (path[0] && __configured() && sg_net_up) ? __pager_request("POST", path, 15000, &j) : -1;
        if (status == 200) {
            cJSON *list = j ? cJSON_GetObjectItem(j, done) : NULL;
            int n = cJSON_IsArray(list) ? cJSON_GetArraySize(list) : 0;
            PR_NOTICE("%s %d incident(s)", done, n);
            /* "snooze" after the page was acknowledged changes nothing: say so rather than sound like it worked. */
            if (voice) sg_chirp = n > 0 ? CHIRP_OK : CHIRP_NO;
        } else {
            /* Didn't go through: ring again so the page isn't silently lost. */
            __unmute();
            if (voice) sg_chirp = CHIRP_NO;
        }
        if (j) cJSON_Delete(j);
    }
}

/***********************************************************
*************************** voice **************************
***********************************************************/
/** Fetches the announcement of the current page from the voice service. The siren does not wait for it. */
static void __voice_say(void)
{
    cJSON *o = cJSON_CreateObject();
    if (!o) return;
    tal_mutex_lock(sg_mutex);
    bool any = sg_st.title[0] != '\0';
    int number = sg_st.number;
    cJSON_AddStringToObject(o, "severity", sg_st.severity[0] ? sg_st.severity : "warning");
    cJSON_AddNumberToObject(o, "number", sg_st.number);
    cJSON_AddStringToObject(o, "title", sg_st.title);
    cJSON_AddStringToObject(o, "service", sg_st.service);
    cJSON_AddNumberToObject(o, "count", sg_st.count);
    tal_mutex_unlock(sg_mutex);
    char *js = any ? cJSON_PrintUnformatted(o) : NULL;
    cJSON_Delete(o);
    if (!js) return;

    http_client_response_t resp = {0};
    int status = __voice_request("/v1/say", "application/json", (const uint8_t *)js, strlen(js), &resp);
    cJSON_free(js);
    if (status == 200 && resp.body && resp.body_length >= 2) {
        uint32_t n = resp.body_length > SAY_MAX_BYTES ? SAY_MAX_BYTES : (uint32_t)resp.body_length;
        n &= ~1u;
        uint8_t *pcm = VOICE_MALLOC(n);
        if (pcm) {
            memcpy(pcm, resp.body, n);
            tal_mutex_lock(sg_mutex);
            if (sg_say_next) VOICE_FREE(sg_say_next);
            sg_say_next = pcm;
            sg_say_next_len = n;
            sg_say_next_num = number;
            sg_say_pending = true;
            tal_mutex_unlock(sg_mutex);
        } else {
            PR_WARN("voice: no memory for %u bytes of speech", n);
        }
    } else {
        PR_WARN("voice: no announcement (%d); the siren carries on alone", status);
    }
    http_client_free(&resp);
}

/** Sends what the held button recorded and acts on the answer. Never acts on a guess. */
static void __voice_hear(void)
{
    http_client_response_t resp = {0};
    uint32_t len = sg_rec_len;
    int status = __voice_request("/v1/hear", "application/octet-stream", sg_rec_buf, len & ~1u, &resp);
    cJSON *j = (status == 200 && resp.body && resp.body_length) ? cJSON_ParseWithLength((const char *)resp.body, resp.body_length) : NULL;
    http_client_free(&resp);

    cJSON *intent = j ? cJSON_GetObjectItem(j, "intent") : NULL;
    cJSON *text = j ? cJSON_GetObjectItem(j, "text") : NULL;
    const char *it = cJSON_IsString(intent) ? intent->valuestring : NULL;
    PR_NOTICE("voice: %u ms heard as \"%s\" -> %s", len * 1000 / (SAMPLE_RATE * 2),
              cJSON_IsString(text) ? text->valuestring : "", it ? it : "(no answer)");

    if (!it) {
        /* The voice service is down: the hold means what it means without voice. */
        __act(ACT_SNOOZE, SNOOZE_MIN, false);
    } else if (strcmp(it, "ack") == 0) {
        __act(ACT_ACK, SNOOZE_MIN, true);
    } else if (strcmp(it, "snooze") == 0) {
        cJSON *m = cJSON_GetObjectItem(j, "minutes");
        __act(ACT_SNOOZE, cJSON_IsNumber(m) && m->valueint >= 1 && m->valueint <= 240 ? m->valueint : SNOOZE_MIN, true);
    } else if (strcmp(it, "resolve") == 0) {
        __act(ACT_RESOLVE, SNOOZE_MIN, true);
    } else if (strcmp(it, "repeat") == 0) {
        __voice_say(); // the service keeps recent ones, so this is quick, and it is the page that rings now
        sg_say_again = true;
        __unmute();
    } else {
        sg_chirp = CHIRP_NO;
        __unmute();
    }
    if (j) cJSON_Delete(j);
}

static void __voice_task(void *arg)
{
    (void)arg;
    for (;;) {
        tal_semaphore_wait_forever(sg_voice_sem);
        if (sg_hear_wanted) {
            __voice_hear();
            sg_hear_wanted = false;
        }
        if (sg_say_wanted) {
            sg_say_wanted = false;
            __voice_say();
        }
    }
}

/** Fills `frame` with a tone; returns the phase to continue from. Square-ish sine at `freq` Hz. */
static uint32_t __tone(int16_t *frame, uint32_t samples, uint32_t freq, uint32_t phase, int16_t amp)
{
    /* phase is a 16.16 fixed-point index into a 64-step period. */
    uint32_t step = (uint32_t)(((uint64_t)freq * 64 << 16) / SAMPLE_RATE);
    for (uint32_t i = 0; i < samples; i++) {
        uint32_t idx = (phase >> 16) & 63;
        int32_t q = idx & 15, v;
        switch (idx >> 4) {
        case 0: v = SINE_Q[q]; break;
        case 1: v = SINE_Q[16 - q]; break;
        case 2: v = -SINE_Q[q]; break;
        default: v = -SINE_Q[16 - q]; break;
        }
        frame[i] = (int16_t)((v * amp) >> 15);
        phase += step;
    }
    return phase;
}

/** Plays `ms` of a tone through the codec, a frame at a time. */
static void __play(uint32_t freq, uint32_t ms, int16_t amp)
{
    static int16_t frame[640]; // 40 ms at 16 kHz
    static uint32_t phase = 0;
    if (!sg_audio) {
        tal_system_sleep(ms);
        return;
    }
    uint32_t frame_bytes = sg_audio_info.frame_size ? sg_audio_info.frame_size : sizeof(frame);
    if (frame_bytes > sizeof(frame)) frame_bytes = sizeof(frame);
    uint32_t samples = frame_bytes / 2;
    uint32_t frame_ms = samples * 1000 / SAMPLE_RATE;
    for (uint32_t t = 0; t < ms; t += frame_ms) {
        if (freq) {
            phase = __tone(frame, samples, freq, phase, amp);
        } else {
            memset(frame, 0, frame_bytes);
        }
        if (tdl_audio_play(sg_audio, (uint8_t *)frame, frame_bytes) != OPRT_OK) sg_play_errors++;
    }
}

/** Plays 16 kHz mono PCM a frame at a time; stops when the button goes down, so speech never talks over a hold. */
static void __play_pcm(const uint8_t *pcm, uint32_t len)
{
    static uint8_t tail[1280];
    uint32_t frame = sg_audio_info.frame_size ? sg_audio_info.frame_size : sizeof(tail);
    if (frame > sizeof(tail)) frame = sizeof(tail);
    for (uint32_t at = 0; at < len && !sg_rec_on; at += frame) {
        const uint8_t *p = pcm + at;
        if (len - at < frame) {
            memcpy(tail, p, len - at);
            memset(tail + (len - at), 0, frame - (len - at));
            p = tail;
        }
        if (tdl_audio_play(sg_audio, (uint8_t *)p, frame) != OPRT_OK) sg_play_errors++;
    }
}

/** Done: two rising notes. Not understood or not sent: two low ones. */
static void __chirp(int kind)
{
    if (kind == CHIRP_OK) {
        __play(880, 120, 16000);
        __play(1320, 160, 16000);
    } else {
        __play(330, 200, 16000);
        __play(0, 80, 0);
        __play(330, 200, 16000);
    }
    __play(0, 200, 0);
}

/** Plays a waiting announcement while the page still rings, or the last one again when asked. True when it spoke. */
static bool __speak(void)
{
    tal_mutex_lock(sg_mutex);
    if (sg_say_next) {
        if (sg_say_cur) VOICE_FREE(sg_say_cur);
        sg_say_cur = sg_say_next;
        sg_say_cur_len = sg_say_next_len;
        sg_say_cur_num = sg_say_next_num;
        sg_say_next = NULL;
    }
    /* Only ever the page that rings now: an older announcement stays quiet when the newer one could not be fetched. */
    bool go = (sg_say_again || sg_say_pending) && sg_st.alert && sg_say_cur_num == sg_st.number;
    sg_say_again = sg_say_pending = false;
    tal_mutex_unlock(sg_mutex);
    if (!go || !sg_say_cur) return false;
    __play(0, 150, 0);
    __play_pcm(sg_say_cur, sg_say_cur_len);
    __play(0, 300, 0);
    return true;
}

/** Measures the test tone in each microphone frame (Goertzel), so room noise at other pitches does not count; keeps
 *  the frames while the button is held in voice mode. */
static void __mic_cb(TDL_AUDIO_FRAME_FORMAT_E type, TDL_AUDIO_STATUS_E status, uint8_t *data, uint32_t len)
{
    (void)type;
    (void)status;
    if (sg_rec_on && sg_rec_buf && data) {
        uint32_t at = sg_rec_len, n = REC_MAX_BYTES - at < len ? REC_MAX_BYTES - at : len;
        memcpy(sg_rec_buf + at, data, n);
        sg_rec_len = at + n;
    }
    if (!sg_mic_open || !data || len < 2) return;
    const int16_t *s = (const int16_t *)data;
    uint32_t n = len / 2;
    float q1 = 0, q2 = 0;
    for (uint32_t i = 0; i < n; i++) {
        float q0 = GOERTZEL_COEFF * q1 - q2 + s[i];
        q2 = q1;
        q1 = q0;
        uint32_t a = s[i] < 0 ? (uint32_t)(-(int32_t)s[i]) : (uint32_t)s[i];
        if (a > sg_mic_peak) sg_mic_peak = a;
    }
    float power = q1 * q1 + q2 * q2 - GOERTZEL_COEFF * q1 * q2;
    sg_mic_tone += (uint64_t)(4.0f * power / ((float)n * (float)n));
    sg_mic_frames++;
}

static uint32_t __isqrt(uint64_t v)
{
    uint64_t r = 0, bit = 1ULL << 62;
    while (bit > v) bit >>= 2;
    while (bit) {
        if (v >= r + bit) {
            v -= r + bit;
            r = (r >> 1) + bit;
        } else {
            r >>= 1;
        }
        bit >>= 2;
    }
    return (uint32_t)r;
}

typedef struct {
    uint32_t tone;   // amplitude of the test tone the microphone heard, 0..32768
    uint32_t peak;   // loudest sample
    uint32_t frames; // 0 means the microphone delivered nothing
} MIC_READING_T;

/** Sets the amplifier and the test tone, lets them settle, and listens for `ms`. */
static MIC_READING_T __mic_measure(bool amp_on, uint32_t tone_hz, uint32_t ms)
{
    MIC_READING_T r;
    tkl_gpio_write(SPK_EN_PIN, amp_on ? TUYA_GPIO_LEVEL_HIGH : TUYA_GPIO_LEVEL_LOW);
    sg_test_tone = tone_hz;
    tal_system_sleep(300);
    sg_mic_open = false;
    sg_mic_tone = 0;
    sg_mic_peak = sg_mic_frames = 0;
    sg_mic_open = true;
    tal_system_sleep(ms);
    sg_mic_open = false;
    r.frames = sg_mic_frames;
    r.peak = sg_mic_peak;
    r.tone = sg_mic_frames ? __isqrt(sg_mic_tone / sg_mic_frames) : 0;
    return r;
}

/** Drives the LED and the siren from the current state. */
static void __alarm_task(void *arg)
{
    int led_mode = -1;
    SYS_TIME_T lost_at = 0, chirped_at = 0, spoke_at = 0;
    (void)arg;
    for (;;) {
        /* Voice comes between siren cycles: a chirp for what was said, then the announcement. Never while held. */
        if (sg_chirp && !sg_rec_on) {
            int kind = sg_chirp;
            sg_chirp = 0;
            __chirp(kind);
        }
        if (!sg_rec_on && __speak()) spoke_at = tal_system_get_millisecond();

        tal_mutex_lock(sg_mutex);
        bool ring = (sg_st.alert && !sg_st.muted) || sg_test_ring || sg_test_tone;
        bool critical = strcmp(sg_st.severity, "critical") == 0 || sg_test_ring;
        int mode = ring ? 3 : sg_st.alert ? 2 : sg_st.link != LINK_ONLINE ? 1 : sg_st.acked ? 2 : 0;
        tal_mutex_unlock(sg_mutex);

        if (mode != led_mode && sg_led) {
            led_mode = mode;
            if (mode == 0) {
                tdl_led_set_status(sg_led, TDL_LED_OFF);
            } else if (mode == 2) {
                tdl_led_set_status(sg_led, TDL_LED_ON);
            } else {
                TDL_LED_BLINK_CFG_T blink = {
                    .cnt = TDL_BLINK_FOREVER,
                    .start_stat = TDL_LED_ON,
                    .first_half_cycle_time = mode == 3 ? 120 : 1000,
                    .latter_half_cycle_time = mode == 3 ? 120 : 1000,
                };
                tdl_led_blink(sg_led, &blink);
            }
        }

        if (sg_test_tone) {
            __play(sg_test_tone, 200, 24000);
        } else if (ring) {
            if (sg_say_cur && sg_say_cur_num == sg_st.number && tal_system_get_millisecond() - spoke_at >= VOICE_REPEAT_MS) {
                sg_say_again = true;
            }
            if (critical) {
                /* Two-tone siren. */
                __play(960, 400, 24000);
                __play(770, 400, 24000);
            } else {
                /* Three beeps, then a pause. */
                for (int i = 0; i < 3; i++) {
                    __play(1200, 150, 20000);
                    __play(0, 120, 0);
                }
                tal_system_sleep(2000);
            }
        } else {
            /* Only a board that has been set up can be missing its server. */
            SYS_TIME_T t = tal_system_get_millisecond();
            if (sg_st.link != LINK_OFFLINE) {
                lost_at = 0;
            } else if (lost_at == 0) {
                lost_at = t;
            } else if (t - lost_at >= OFFLINE_CHIRP_AFTER_MS && t - chirped_at >= OFFLINE_CHIRP_EVERY_MS) {
                chirped_at = t;
                PR_WARN("server unreachable for %u s", (uint32_t)((t - lost_at) / 1000));
                __play(1800, 80, 12000);
            }
            tal_system_sleep(100);
        }
    }
}

/***********************************************************
************************** button **************************
***********************************************************/
static void __button_cb(char *name, TDL_BUTTON_TOUCH_EVENT_E event, void *argc)
{
    (void)name;
    (void)argc;
    if (event == TDL_BUTTON_PRESS_DOWN) {
        if (sg_test_ring) {
            sg_test_ring = false;
            return;
        }
        /* Silence at once. What the press means is known only when it ends: a tap acknowledges, a hold snoozes, or
           with voice on, a hold is listened to. Recording starts now so the first word is not lost. */
        tal_mutex_lock(sg_mutex);
        sg_st.muted = true;
        bool active = sg_st.alert || sg_st.acked;
        tal_mutex_unlock(sg_mutex);
        if (active && __voice_on() && !sg_hear_wanted) {
            sg_rec_len = 0;
            sg_rec_long = false;
            sg_rec_on = true;
        }
    } else if (event == TDL_BUTTON_PRESS_UP) {
        sg_rec_on = false;
        if (sg_rec_long) {
            sg_rec_long = false;
            sg_hear_wanted = true;
            tal_semaphore_post(sg_voice_sem);
        }
    } else if (event == TDL_BUTTON_PRESS_SINGLE_CLICK || event == TDL_BUTTON_PRESS_DOUBLE_CLICK ||
               event == TDL_BUTTON_PRESS_REPEAT) {
        tal_mutex_lock(sg_mutex);
        bool alerting = sg_st.alert;
        tal_mutex_unlock(sg_mutex);
        if (alerting) {
            PR_NOTICE("button: acknowledging");
            __act(ACT_ACK, SNOOZE_MIN, false);
        }
    } else if (event == TDL_BUTTON_LONG_PRESS_START) {
        PR_NOTICE("button: link=%d alert=%d count=%d acked=%d %s", sg_st.link, sg_st.alert, sg_st.count, sg_st.acked,
                  sg_st.title);
        if (sg_rec_on) {
            /* Voice: what was said decides, once the button is released. */
            PR_NOTICE("button: listening");
            sg_rec_long = true;
            return;
        }
        tal_mutex_lock(sg_mutex);
        bool alerting = sg_st.alert;
        tal_mutex_unlock(sg_mutex);
        if (alerting) {
            PR_NOTICE("button: snoozing");
            __act(ACT_SNOOZE, SNOOZE_MIN, false);
        }
    }
}

/***********************************************************
************************ serial CLI ************************
***********************************************************/
static void __cmd_wifi(int argc, char *argv[])
{
    if (argc < 2) {
        tal_cli_echo("usage: pager_wifi <ssid> [password]\r\n");
        return;
    }
    __kv_write(KV_SSID, argv[1]);
    __kv_write(KV_PSWD, argc > 2 ? argv[2] : "");
    __load_cfg();
    __wifi_connect();
    tal_cli_echo("Wi-Fi saved\r\n");
}

static void __cmd_url(int argc, char *argv[])
{
    PAGER_CFG_T probe = {0};
    if (argc < 2 || strlen(argv[1]) >= sizeof(probe.url)) {
        tal_cli_echo("usage: pager_url http://192.168.1.20:8787 | https://pager.example.com\r\n");
        return;
    }
    strcpy(probe.url, argv[1]);
    if (!__parse_url(&probe)) {
        tal_cli_echo("URL must start with http:// or https://\r\n");
        return;
    }
    __kv_write(KV_URL, argv[1]);
    __load_cfg();
    sg_st.version = 0;
    tal_semaphore_post(sg_wake_sem);
    tal_cli_echo("server saved\r\n");
}

static void __cmd_token(int argc, char *argv[])
{
    if (argc < 2 || strncmp(argv[1], "dev_", 4) != 0) {
        tal_cli_echo("usage: pager_token dev_xxxx (from the app: Settings > Devices)\r\n");
        return;
    }
    __kv_write(KV_TOKEN, argv[1]);
    __load_cfg();
    sg_st.version = 0;
    tal_semaphore_post(sg_wake_sem);
    tal_cli_echo("token saved\r\n");
}

static void __cmd_voice(int argc, char *argv[])
{
    char host[128];
    uint16_t port;
    bool tls;
    if (argc == 2 && strcmp(argv[1], "off") == 0) {
        tal_kv_del(KV_VURL);
        tal_kv_del(KV_VTOK);
        __load_cfg();
        tal_cli_echo("voice off (pager_reboot gives the long press back its 2 s)\r\n");
        return;
    }
    if (argc < 3 || strlen(argv[1]) >= sizeof(sg_cfg.vurl) || strlen(argv[2]) >= sizeof(sg_cfg.vtoken) ||
        !__parse_url_to(argv[1], host, sizeof(host), &port, &tls)) {
        tal_cli_echo("usage: pager_voice http://192.168.1.20:8790 <voice token>  |  pager_voice off\r\n");
        return;
    }
    if (!sg_audio || !sg_rec_buf) {
        tal_cli_echo("this board cannot record (no audio codec or no memory): voice stays off\r\n");
        return;
    }
    __kv_write(KV_VURL, argv[1]);
    __kv_write(KV_VTOK, argv[2]);
    __load_cfg();
    tal_cli_echo("voice saved: hold the button and speak. pager_reboot makes the hold 0.8 s instead of 2 s\r\n");
}

static void __cmd_clear(int argc, char *argv[])
{
    (void)argc;
    (void)argv;
    tal_kv_del(KV_URL);
    tal_kv_del(KV_TOKEN);
    __load_cfg();
    tal_mutex_lock(sg_mutex);
    sg_st.alert = false;
    sg_st.count = sg_st.acked = 0;
    sg_st.version = 0;
    tal_mutex_unlock(sg_mutex);
    tal_semaphore_post(sg_wake_sem);
    tal_cli_echo("server and token cleared\r\n");
}

static void __cmd_show(int argc, char *argv[])
{
    char buf[600];
    (void)argc;
    (void)argv;
    snprintf(buf, sizeof(buf),
             "%s\r\nwifi: %s (%s)\r\nserver: %s -> %s:%u %s\r\ntoken: %s\r\nvoice: %s%s\r\nlink: %s\r\n"
             "alert: %d count: %d acked: %d\r\ntop: #%d [%s] %s\r\n",
             FW_VERSION, sg_cfg.ssid[0] ? sg_cfg.ssid : "-", sg_net_up ? "up" : "down", sg_cfg.url[0] ? sg_cfg.url : "-",
             sg_cfg.host, sg_cfg.port, sg_cfg.tls ? "tls" : "plain", sg_cfg.token[0] ? "set" : "-",
             sg_cfg.vurl[0] ? sg_cfg.vurl : "off", sg_cfg.vurl[0] && !__voice_on() ? " (cannot record: off)" : "",
             sg_st.link == LINK_ONLINE ? "online" : sg_st.link == LINK_OFFLINE ? "offline" : "unconfigured", sg_st.alert,
             sg_st.count, sg_st.acked, sg_st.number, sg_st.severity, sg_st.title);
    tal_cli_echo(buf);
}

static void __cmd_test(int argc, char *argv[])
{
    (void)argc;
    (void)argv;
    sg_test_ring = true;
    tal_cli_echo("ringing for 5 s (press the button to stop)\r\n");
    tal_system_sleep(5000);
    sg_test_ring = false;
}

static void __cmd_audio(int argc, char *argv[])
{
    char buf[360];
    (void)argc;
    (void)argv;
    if (!sg_audio) {
        tal_cli_echo("no audio codec\r\n");
        return;
    }
    if (sg_st.alert) {
        tal_cli_echo("a page is ringing: try again when it is clear\r\n");
        return;
    }
    uint32_t errors = sg_play_errors;
    /* The amplifier-off reading is the control: a tone heard with it off leaked inside the chip, not through the air. */
    MIC_READING_T room = __mic_measure(true, 0, 1000);
    MIC_READING_T off = __mic_measure(false, TEST_TONE_HZ, 1500);
    MIC_READING_T on = __mic_measure(true, TEST_TONE_HZ, 1500);
    sg_test_tone = 0;
    tkl_gpio_write(SPK_EN_PIN, TUYA_GPIO_LEVEL_HIGH);

    uint32_t floor_tone = room.tone > off.tone ? room.tone : off.tone;
    const char *verdict = !on.frames                      ? "NO (microphone gave no data)"
                          : on.tone >= 3 * floor_tone + 20 ? "yes"
                          : off.tone >= 3 * room.tone + 20 ? "NO (tone only leaks inside the chip; amplifier or speaker silent)"
                                                           : "NO (nothing heard)";
    snprintf(buf, sizeof(buf),
             "room:        tone %u peak %u (%u frames)\r\namp off+tone: tone %u peak %u (%u frames)\r\n"
             "amp on+tone:  tone %u peak %u (%u frames)\r\nplay errors: %u\r\nspeaker heard: %s\r\n",
             room.tone, room.peak, room.frames, off.tone, off.peak, off.frames, on.tone, on.peak, on.frames,
             sg_play_errors - errors, verdict);
    tal_cli_echo(buf);
}

static void __cmd_reboot(int argc, char *argv[])
{
    (void)argc;
    (void)argv;
    tal_system_reset();
}

static const cli_cmd_t sg_cmds[] = {
    {.name = "pager_wifi", .help = "pager_wifi <ssid> [password]", .func = __cmd_wifi},
    {.name = "pager_url", .help = "pager_url <http(s)://host[:port]>", .func = __cmd_url},
    {.name = "pager_token", .help = "pager_token <dev_...>", .func = __cmd_token},
    {.name = "pager_voice", .help = "pager_voice <http(s)://host[:port]> <voice token> | off", .func = __cmd_voice},
    {.name = "pager_clear", .help = "forget the server and token", .func = __cmd_clear},
    {.name = "pager_show", .help = "show settings and state", .func = __cmd_show},
    {.name = "pager_test", .help = "ring for 5 seconds", .func = __cmd_test},
    {.name = "pager_audio", .help = "ring for 2 seconds and report what the microphone heard", .func = __cmd_audio},
    {.name = "pager_reboot", .help = "reboot", .func = __cmd_reboot},
};

/***********************************************************
*************************** main ***************************
***********************************************************/
static OPERATE_RET __link_status_cb(void *data)
{
    netmgr_status_e status = *((netmgr_status_e *)data);
    sg_net_up = (status == NETMGR_LINK_UP);
    PR_NOTICE("network %s", sg_net_up ? "up" : "down");
    if (sg_net_up) tal_semaphore_post(sg_wake_sem);
    return OPRT_OK;
}

static void __start_thread(THREAD_HANDLE *h, const char *name, uint32_t stack, THREAD_FUNC_CB fn)
{
    THREAD_CFG_T cfg = {.stackDepth = stack, .priority = THREAD_PRIO_2, .thrdname = (char *)name};
    tal_thread_create_and_start(h, NULL, NULL, fn, NULL, &cfg);
}

static void user_main(void)
{
    tal_log_init(TAL_LOG_LEVEL_INFO, 1024, (TAL_LOG_OUTPUT_CB)tkl_log_output);
    PR_NOTICE("%s (TuyaOpen %s, board %s)", FW_VERSION, OPEN_VERSION, PLATFORM_BOARD);

    tal_kv_init(&(tal_kv_cfg_t){.seed = "pagerT5AIseed001", .key = "pagerT5AIkey0001"});
    tal_sw_timer_init();
    tal_workq_init();
    tuya_tls_init();
    tal_cli_init();
    tal_cli_cmd_register(sg_cmds, sizeof(sg_cmds) / sizeof(sg_cmds[0]));

    tal_mutex_create_init(&sg_mutex);
    tal_semaphore_create_init(&sg_ack_sem, 0, 1);
    tal_semaphore_create_init(&sg_wake_sem, 0, 1);
    tal_semaphore_create_init(&sg_voice_sem, 0, 1);
    __load_cfg();

    /* Board peripherals: LED (GPIO9), button (GPIO29), audio codec + speaker. */
    board_register_hardware();
    sg_led = tdl_led_find_dev(LED_NAME);
    if (sg_led) tdl_led_open(sg_led);

    TDL_BUTTON_CFG_T button_cfg = {.long_start_valid_time = __voice_configured() ? VOICE_HOLD_MS : HOLD_MS,
                                   .long_keep_timer = 1000,
                                   .button_debounce_time = 50,
                                   .button_repeat_valid_count = 2,
                                   .button_repeat_valid_time = 500};
    TDL_BUTTON_HANDLE button = NULL;
    if (tdl_button_create(BUTTON_NAME, &button_cfg, &button) == OPRT_OK) {
        tdl_button_event_register(button, TDL_BUTTON_PRESS_DOWN, __button_cb);
        tdl_button_event_register(button, TDL_BUTTON_PRESS_UP, __button_cb);
        tdl_button_event_register(button, TDL_BUTTON_PRESS_SINGLE_CLICK, __button_cb);
        tdl_button_event_register(button, TDL_BUTTON_PRESS_DOUBLE_CLICK, __button_cb);
        tdl_button_event_register(button, TDL_BUTTON_PRESS_REPEAT, __button_cb);
        tdl_button_event_register(button, TDL_BUTTON_LONG_PRESS_START, __button_cb);
    }

#if defined(AUDIO_CODEC_NAME)
    /* The board's own registration turns echo cancellation on, which is for talking and removes the very siren
       pager_audio listens for. The pager never plays while it records (a press silences it), so open the codec
       without it. */
    TDD_AUDIO_T5AI_T audio_cfg = {.aec_enable = 0,
                                  .ai_chn = TKL_AI_0,
                                  .sample_rate = TKL_AUDIO_SAMPLE_16K,
                                  .data_bits = TKL_AUDIO_DATABITS_16,
                                  .channel = TKL_AUDIO_CHANNEL_MONO,
                                  .spk_sample_rate = TKL_AUDIO_SAMPLE_16K,
                                  .spk_pin = SPK_EN_PIN,
                                  .spk_pin_polarity = TUYA_GPIO_LEVEL_LOW};
    if (tdd_audio_register(PAGER_AUDIO_NAME, audio_cfg) == OPRT_OK && tdl_audio_find(PAGER_AUDIO_NAME, &sg_audio) == OPRT_OK &&
        tdl_audio_open(sg_audio, __mic_cb) == OPRT_OK) {
        tdl_audio_get_info(sg_audio, &sg_audio_info);
        tdl_audio_volume_set(sg_audio, SIREN_VOLUME);
        PR_NOTICE("audio: frame %u bytes, %u ms", sg_audio_info.frame_size, sg_audio_info.sample_tm_ms);
        sg_rec_buf = VOICE_MALLOC(REC_MAX_BYTES);
        if (!sg_rec_buf) PR_WARN("no memory to record: voice off");
    } else {
        sg_audio = NULL;
        PR_WARN("audio codec unavailable: LED only");
    }
#endif

    tal_event_subscribe(EVENT_LINK_STATUS_CHG, "pager", __link_status_cb, SUBSCRIBE_TYPE_NORMAL);

#if defined(ENABLE_LIBLWIP) && (ENABLE_LIBLWIP == 1)
    TUYA_LwIP_Init();
#endif
    netmgr_type_e type = 0;
#if defined(ENABLE_WIFI) && (ENABLE_WIFI == 1)
    type |= NETCONN_WIFI;
#endif
    netmgr_init(type);
    __wifi_connect();

    __start_thread(&sg_alarm_thrd, "pager_alarm", 4096, __alarm_task);
    __start_thread(&sg_ack_thrd, "pager_ack", 8192, __ack_task);
    __start_thread(&sg_poll_thrd, "pager_poll", 8192, __poll_task);
    __start_thread(&sg_voice_thrd, "pager_voice", 8192, __voice_task);
    if (__voice_configured()) PR_NOTICE("voice: %s%s", sg_cfg.vurl, __voice_on() ? "" : " (cannot record: off)");

    if (!__configured() || !sg_cfg.ssid[0]) {
        PR_NOTICE("set me up over this serial port: pager_wifi, pager_url, pager_token (see pager_show)");
    }
}

#if OPERATING_SYSTEM == SYSTEM_LINUX
void main(int argc, char *argv[])
{
    user_main();
    while (1) {
        tal_system_sleep(500);
    }
}
#else
static THREAD_HANDLE ty_app_thread = NULL;

static void tuya_app_thread(void *arg)
{
    user_main();
    tal_thread_delete(ty_app_thread);
    ty_app_thread = NULL;
}

void tuya_app_main(void)
{
    THREAD_CFG_T thrd_param = {0};
    thrd_param.stackDepth = 1024 * 6;
    thrd_param.priority = THREAD_PRIO_1;
    thrd_param.thrdname = "tuya_app_main";
    tal_thread_create_and_start(&ty_app_thread, NULL, NULL, tuya_app_thread, NULL, &thrd_param);
}
#endif
