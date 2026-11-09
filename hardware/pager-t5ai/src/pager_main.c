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
 *   pager_show       pager_test       pager_reboot
 *   pager_audio      ring for 2 s and report what the microphone heard
 *   pager_clear      forget the server and token; the board goes quiet until it is set up again
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
#define SNOOZE_PATH       "/v1/device/snooze?minutes=30"
#define OFFLINE_CHIRP_AFTER_MS (5 * 60 * 1000)
#define OFFLINE_CHIRP_EVERY_MS (60 * 1000)

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
} PAGER_CFG_T;

typedef struct {
    LINK_STATE_E link;
    bool alert;      // unacknowledged pages for this device's user
    int count;       // how many
    int acked;       // acknowledged, still open
    char severity[12];
    char title[128];
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
static volatile bool sg_snooze_wanted = false; // the next post of sg_ack_sem means snooze, not acknowledge
static volatile bool sg_mic_open = false;      // __mic_cb is adding up a measurement
static volatile uint32_t sg_test_tone = 0;    // the alarm thread plays this frequency while it is non-zero
static uint64_t sg_mic_tone;
static uint32_t sg_mic_peak, sg_mic_frames;
static volatile uint32_t sg_play_errors = 0;

static TDL_LED_HANDLE_T sg_led;
static TDL_AUDIO_HANDLE_T sg_audio;
static TDL_AUDIO_INFO_T sg_audio_info;

static THREAD_HANDLE sg_poll_thrd, sg_alarm_thrd, sg_ack_thrd;

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
static bool __parse_url(PAGER_CFG_T *c)
{
    const char *p = c->url;
    if (strncmp(p, "https://", 8) == 0) {
        c->tls = true;
        c->port = 443;
        p += 8;
    } else if (strncmp(p, "http://", 7) == 0) {
        c->tls = false;
        c->port = 80;
        p += 7;
    } else {
        return false;
    }
    size_t i = 0;
    while (*p && *p != ':' && *p != '/' && i < sizeof(c->host) - 1) {
        c->host[i++] = *p++;
    }
    c->host[i] = '\0';
    if (*p == ':') {
        c->port = (uint16_t)atoi(p + 1);
    }
    return i > 0 && c->port > 0;
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
    tal_mutex_unlock(sg_mutex);
}

static bool __configured(void)
{
    return sg_cfg.host[0] && sg_cfg.token[0];
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
/** One request to the pager server. On success *body (caller frees with cJSON_Delete) holds the parsed JSON. */
static int __pager_request(const char *method, const char *path, uint32_t timeout_ms, cJSON **body)
{
    char auth[112];
    PAGER_CFG_T c;

    tal_mutex_lock(sg_mutex);
    memcpy(&c, &sg_cfg, sizeof(c));
    tal_mutex_unlock(sg_mutex);

    snprintf(auth, sizeof(auth), "Device %s", c.token);
    http_client_header_t headers[] = {
        {.key = "Authorization", .value = auth},
        {.key = "X-Firmware", .value = FW_VERSION},
        {.key = "Content-Type", .value = "application/json"},
    };
    http_client_response_t resp = {0};
    http_client_status_t st = http_client_request(
        &(const http_client_request_t){
            .cacert = c.tls ? (const uint8_t *)PAGER_CA_BUNDLE : NULL,
            .cacert_len = c.tls ? PAGER_CA_BUNDLE_LEN : 0,
            .host = c.host,
            .port = c.port,
            .method = method,
            .path = path,
            .headers = headers,
            .headers_count = sizeof(headers) / sizeof(headers[0]),
            .body = (const uint8_t *)"",
            .body_length = 0,
            .timeout_ms = timeout_ms,
        },
        &resp);

    int status = -1;
    if (st != HTTP_CLIENT_SUCCESS) {
        PR_ERR("%s %s: http error %d", method, path, st);
    } else {
        status = resp.status_code;
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
    sg_st.title[0] = sg_st.severity[0] = '\0';
    sg_st.number = 0;
    if (cJSON_IsObject(top)) {
        cJSON *t = cJSON_GetObjectItem(top, "title");
        cJSON *s = cJSON_GetObjectItem(top, "severity");
        cJSON *n = cJSON_GetObjectItem(top, "number");
        if (cJSON_IsString(t)) strncpy(sg_st.title, t->valuestring, sizeof(sg_st.title) - 1);
        if (cJSON_IsString(s)) strncpy(sg_st.severity, s->valuestring, sizeof(sg_st.severity) - 1);
        if (cJSON_IsNumber(n)) sg_st.number = n->valueint;
    }
    /* Muting lasts until the pages are gone or a new one arrives. */
    if (!sg_st.alert || sg_st.count > prev_count) sg_st.muted = false;
    sg_st.link = LINK_ONLINE;
    bool newly = sg_st.alert && (!prev_alert || sg_st.count > prev_count);
    tal_mutex_unlock(sg_mutex);

    if (newly) {
        PR_NOTICE(">>> PAGE #%d [%s] %s (%d unacknowledged)", sg_st.number, sg_st.severity, sg_st.title, sg_st.count);
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

/** Sends acknowledgements when the button asks for one. */
static void __ack_task(void *arg)
{
    (void)arg;
    for (;;) {
        tal_semaphore_wait_forever(sg_ack_sem);
        bool snooze = sg_snooze_wanted;
        sg_snooze_wanted = false;
        cJSON *j = NULL;
        /* No network means the press reached nobody: fall through and ring again, or the page is silently lost. */
        int status = (__configured() && sg_net_up) ? __pager_request("POST", snooze ? SNOOZE_PATH : "/v1/device/ack", 15000, &j) : -1;
        if (status == 200) {
            cJSON *list = j ? cJSON_GetObjectItem(j, snooze ? "snoozed" : "acknowledged") : NULL;
            PR_NOTICE("%s %d incident(s)", snooze ? "snoozed" : "acknowledged", cJSON_IsArray(list) ? cJSON_GetArraySize(list) : 0);
        } else {
            /* Didn't go through: ring again so the page isn't silently lost. */
            tal_mutex_lock(sg_mutex);
            sg_st.muted = false;
            tal_mutex_unlock(sg_mutex);
        }
        if (j) cJSON_Delete(j);
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

/** Measures the test tone in each microphone frame (Goertzel), so room noise at other pitches does not count. */
static void __mic_cb(TDL_AUDIO_FRAME_FORMAT_E type, TDL_AUDIO_STATUS_E status, uint8_t *data, uint32_t len)
{
    (void)type;
    (void)status;
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
    SYS_TIME_T lost_at = 0, chirped_at = 0;
    (void)arg;
    for (;;) {
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
        /* Silence at once. What the press means is known only when it ends: a tap acknowledges, a hold snoozes. */
        tal_mutex_lock(sg_mutex);
        sg_st.muted = true;
        tal_mutex_unlock(sg_mutex);
    } else if (event == TDL_BUTTON_PRESS_SINGLE_CLICK || event == TDL_BUTTON_PRESS_DOUBLE_CLICK ||
               event == TDL_BUTTON_PRESS_REPEAT) {
        tal_mutex_lock(sg_mutex);
        bool alerting = sg_st.alert;
        tal_mutex_unlock(sg_mutex);
        if (alerting) {
            PR_NOTICE("button: acknowledging");
            tal_semaphore_post(sg_ack_sem);
        }
    } else if (event == TDL_BUTTON_LONG_PRESS_START) {
        PR_NOTICE("button: link=%d alert=%d count=%d acked=%d %s", sg_st.link, sg_st.alert, sg_st.count, sg_st.acked,
                  sg_st.title);
        tal_mutex_lock(sg_mutex);
        bool alerting = sg_st.alert;
        tal_mutex_unlock(sg_mutex);
        if (alerting) {
            PR_NOTICE("button: snoozing");
            sg_snooze_wanted = true;
            tal_semaphore_post(sg_ack_sem);
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
    char buf[400];
    (void)argc;
    (void)argv;
    snprintf(buf, sizeof(buf),
             "%s\r\nwifi: %s (%s)\r\nserver: %s -> %s:%u %s\r\ntoken: %s\r\nlink: %s\r\nalert: %d count: %d acked: %d\r\n"
             "top: #%d [%s] %s\r\n",
             FW_VERSION, sg_cfg.ssid[0] ? sg_cfg.ssid : "-", sg_net_up ? "up" : "down", sg_cfg.url[0] ? sg_cfg.url : "-",
             sg_cfg.host, sg_cfg.port, sg_cfg.tls ? "tls" : "plain", sg_cfg.token[0] ? "set" : "-",
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

    /* Board peripherals: LED (GPIO9), button (GPIO29), audio codec + speaker. */
    board_register_hardware();
    sg_led = tdl_led_find_dev(LED_NAME);
    if (sg_led) tdl_led_open(sg_led);

    TDL_BUTTON_CFG_T button_cfg = {.long_start_valid_time = 2000,
                                   .long_keep_timer = 1000,
                                   .button_debounce_time = 50,
                                   .button_repeat_valid_count = 2,
                                   .button_repeat_valid_time = 500};
    TDL_BUTTON_HANDLE button = NULL;
    if (tdl_button_create(BUTTON_NAME, &button_cfg, &button) == OPRT_OK) {
        tdl_button_event_register(button, TDL_BUTTON_PRESS_DOWN, __button_cb);
        tdl_button_event_register(button, TDL_BUTTON_PRESS_SINGLE_CLICK, __button_cb);
        tdl_button_event_register(button, TDL_BUTTON_PRESS_DOUBLE_CLICK, __button_cb);
        tdl_button_event_register(button, TDL_BUTTON_PRESS_REPEAT, __button_cb);
        tdl_button_event_register(button, TDL_BUTTON_LONG_PRESS_START, __button_cb);
    }

#if defined(AUDIO_CODEC_NAME)
    /* The board's own registration turns echo cancellation on, which is for talking and removes the very siren
       pager_audio listens for. A pager never talks, so open the codec without it. */
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
    } else {
        sg_audio = NULL;
        PR_WARN("audio codec unavailable: LED only");
    }
#endif

    __load_cfg();
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
