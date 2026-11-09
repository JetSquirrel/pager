// One line icon set, drawn in a 24 × 24 box with the tint as stroke.
import { Canvas, Path2D } from "nsh";

const PATHS = {
  bell: "M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9M10.3 20a2 2 0 0 0 3.4 0",
  calendar: "M5 5h14a1.5 1.5 0 0 1 1.5 1.5v12.5a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V6.5A1.5 1.5 0 0 1 5 5zM8 3v4M16 3v4M3.5 10.5h17",
  sliders: "M4 7h9M17 7h3M4 17h3M11 17h9M13 7a2 2 0 1 0 4 0a2 2 0 1 0-4 0M7 17a2 2 0 1 0 4 0a2 2 0 1 0-4 0",
  shield: "M12 3l7.5 3v5.5c0 4.6-3.1 8-7.5 9.5-4.4-1.5-7.5-4.9-7.5-9.5V6z",
  check: "M5 12.5l4.5 4.5L19 7",
  plus: "M12 5v14M5 12h14",
  back: "M15 5l-7 7 7 7",
  down: "M6 9l6 6 6-6",
  close: "M6 6l12 12M18 6L6 18",
  refresh: "M20 11a8 8 0 0 0-14.3-4.3L3.5 9M3.5 4v5h5M4 13a8 8 0 0 0 14.3 4.3l2.2-2.3M20.5 20v-5h-5",
  copy: "M10.5 9h8a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 9 18.5v-8A1.5 1.5 0 0 1 10.5 9zM15 5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15",
  trash: "M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v5M14 11v5",
  alert: "M12 4l9 16H3zM12 10v4M12 17.2v.1",
  zap: "M13 3L5 13.5h6L10 21l8-10.5h-6z",
  hash: "M5 9h14M5 15h14M10 4L8 20M16 4l-2 16",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  monitor: "M4.5 4.5h15A1.5 1.5 0 0 1 21 6v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 15V6a1.5 1.5 0 0 1 1.5-1.5zM8.5 20.5h7M12 16.5v4",
  phone: "M8.5 3h7A1.5 1.5 0 0 1 17 4.5v15a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 7 19.5v-15A1.5 1.5 0 0 1 8.5 3zM11.5 18h1",
} as const;

export type IconName = keyof typeof PATHS;

const paths = new Map<IconName, Path2D>();
const path = (name: IconName) => {
  let p = paths.get(name);
  if (!p) paths.set(name, (p = new Path2D(PATHS[name])));
  return p;
};

/** A line icon. `tint` is a color: pass `token("…")` so it follows the appearance. */
export function Icon(props: { name: IconName; size?: number; tint: string }) {
  const size = props.size ?? 16;
  return (
    <Canvas
      pointerEvents="none"
      style={{ width: size, height: size }}
      draw={(cx, { width }) => {
        cx.scale(width / 24, width / 24);
        cx.strokeStyle = props.tint;
        cx.lineWidth = 1.8;
        cx.lineCap = "round";
        cx.lineJoin = "round";
        cx.stroke(path(props.name));
      }}
    />
  );
}
