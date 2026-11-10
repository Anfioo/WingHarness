// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
declare module 'xlsx/dist/cpexcel.full.mjs';
declare module 'mammoth/mammoth.browser';
declare module 'seek-bzip' {
  const Bunzip: {
    decode(
      input: {
        readByte(): number;
        eof(): boolean;
        read(target: Uint8Array, offset: number, length: number): number;
      },
      output: { writeByte(value: number): void },
      multistream?: boolean,
    ): void;
  };
  export default Bunzip;
}
declare module 'lottie-web/build/player/lottie_light' {
  const player: typeof import('lottie-web').default;
  export default player;
}
