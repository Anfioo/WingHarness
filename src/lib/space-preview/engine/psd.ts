// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
// The PSD composite needs a canvas, so this module belongs on the main thread.
import { readPsd, type Layer } from 'ag-psd';

export interface PsdDocument {
  width: number;
  height: number;
  layers: string[];
  canvas: HTMLCanvasElement;
}

export function readPsdDocument(bytes: Uint8Array): PsdDocument {
  const psd = readPsd(bytes, { skipLayerImageData: true, skipThumbnail: true });
  if (!psd.canvas) throw new Error('This PSD has no saved composite, so there is no image to show.');
  return {
    width: psd.width,
    height: psd.height,
    layers: flattenLayers(psd.children ?? []),
    canvas: psd.canvas,
  };
}

export function psdPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (value) => (value ? resolve(value) : reject(new Error('Could not render the PSD composite.'))),
      'image/png',
    ),
  );
}

function flattenLayers(layers: Layer[]): string[] {
  return layers.flatMap((layer) => [
    layer.name ?? '(unnamed layer)',
    ...flattenLayers(layer.children ?? []),
  ]);
}
