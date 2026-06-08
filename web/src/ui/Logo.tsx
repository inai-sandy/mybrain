/** The My Brain logo mark (the app icon), for in-app brand spots. */
export function Logo({ size = 28, className = '' }: { size?: number; className?: string }) {
  return (
    <img
      src="/icons/icon-192.png"
      alt="My Brain"
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className={'rounded-lg shrink-0 ' + className}
    />
  );
}
