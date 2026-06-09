import Image from "next/image";

/**
 * The Baseline logo mark. The default mark is ink-on-transparent and vanishes on
 * the dark nav, so we render both variants and let CSS toggle them by theme
 * (see the .brand-mark-* rules in globals.css). Both are decorative — the
 * adjacent wordmark carries the name.
 */
export function BrandMark({ size = 20 }: { size?: number }) {
  return (
    <>
      <Image
        src="/logo-mark.svg"
        width={size}
        height={size}
        alt=""
        priority
        className="brand-mark-light"
      />
      <Image
        src="/logo-mark-dark.svg"
        width={size}
        height={size}
        alt=""
        priority
        className="brand-mark-dark"
      />
    </>
  );
}
