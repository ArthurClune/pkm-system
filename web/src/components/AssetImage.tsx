// pattern: Functional Core
export function AssetImage({ src, alt }: { src: string; alt: string }) {
  return <img className="asset-image" src={src} alt={alt} loading="lazy" />;
}
