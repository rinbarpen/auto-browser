import jsQR from 'jsqr';

export function decodeQrFromImageData(imageData: { data: Uint8ClampedArray; width: number; height: number }): string | null {
  const fn = (jsQR as unknown) as (d: Uint8ClampedArray, w: number, h: number) => { data: string } | null;
  const result = fn(imageData.data, imageData.width, imageData.height);
  return result?.data ?? null;
}

export function isLikelyUrl(text: string): boolean {
  return /^https?:\/\//i.test(text) || text.includes('pan.baidu.com') || text.includes('aliyundrive.com');
}
