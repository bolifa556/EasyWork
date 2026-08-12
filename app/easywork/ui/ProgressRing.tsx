type Props = { value: number; size?: number; color?: "green" | "purple"; label?: string };

export function ProgressRing({ value, size = 22, color = "green", label }: Props) {
  const normalized = Math.max(0, Math.min(1, value));
  const degrees = `${Math.round(normalized * 360)}deg`;
  const active = color === "purple" ? "var(--ew-purple)" : "var(--ew-green)";
  return (
    <span
      role="img"
      aria-label={label ?? `已使用 ${Math.round(normalized * 100)}%`}
      style={{
        width: size,
        height: size,
        display: "inline-block",
        flex: `0 0 ${size}px`,
        borderRadius: "50%",
        background: `conic-gradient(${active} ${degrees}, rgba(66, 69, 60, .18) 0)`,
        WebkitMask: "radial-gradient(circle, transparent 51%, #000 53%)",
        mask: "radial-gradient(circle, transparent 51%, #000 53%)",
      }}
    />
  );
}
