import * as FileSystemLegacy from 'expo-file-system/legacy';
import { buildPdfFilename } from './pdf-export';

let imageExportCounter = 0;

export const buildImageFilename = (parts: readonly string[]): string =>
  buildPdfFilename(parts.map(part => part.replace(/\.png$/i, ''))).replace(/\.pdf$/i, '.png');

export const getImageCaptureSize = (width: number, height: number, pixelRatio: number, platform = 'android') => {
  if (![width, height, pixelRatio].every(value => Number.isFinite(value) && value > 0)) return null;
  const nativeWidth = Math.ceil(width * pixelRatio);
  const nativeHeight = Math.ceil(height * pixelRatio);
  if (nativeWidth > 4096 || nativeHeight > 8192 || nativeWidth * nativeHeight > 8000000) return null;
  const scale = Math.min(pixelRatio, 2, 1200 / width);
  const units = platform === 'ios' ? pixelRatio : 1;
  return { width: Math.ceil(width * scale) / units, height: Math.ceil(height * scale) / units };
};

export const copyImageForExport = async (sourceUri: string, filename: string): Promise<string> => {
  const cacheDirectory = FileSystemLegacy.cacheDirectory;
  if (!cacheDirectory) throw new Error('Image export cache directory is unavailable.');
  const directory = `${cacheDirectory.replace(/\/?$/, '/')}image-exports/${Date.now()}-${++imageExportCounter}/`;
  const destination = `${directory}${buildImageFilename([filename])}`;
  await FileSystemLegacy.makeDirectoryAsync(directory, { intermediates: true });
  await FileSystemLegacy.copyAsync({ from: sourceUri, to: destination });
  return destination;
};