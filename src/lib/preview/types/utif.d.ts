declare module "utif" {
  export type TiffImage = {
    width: number;
    height: number;
    [key: string]: unknown;
  };

  const UTIF: {
    decode(buffer: ArrayBuffer): TiffImage[];
    decodeImage(buffer: ArrayBuffer, image: TiffImage): void;
    toRGBA8(image: TiffImage): Uint8Array;
    encodeImage(rgba: ArrayBuffer | Uint8Array, width: number, height: number): ArrayBuffer;
  };

  export default UTIF;
}
