import { fileAssetUrl } from "../api/platform";
import { pixelsToAscii } from "./visual";

const ASCII_COLS = 96;
const CHAR_ASPECT = 0.5;

export async function imageFileToAscii(path: string): Promise<string | null> {
  const img = new Image();
  const loaded = new Promise<boolean>((resolve) => {
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
  });
  img.src = fileAssetUrl(path);
  if (!(await loaded)) return null;

  const cols = ASCII_COLS;
  const rows = Math.max(
    1,
    Math.round((img.naturalHeight / Math.max(1, img.naturalWidth)) * cols * CHAR_ASPECT),
  );
  const canvas = document.createElement("canvas");
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  ctx.drawImage(img, 0, 0, cols, rows);
  try {
    const data = ctx.getImageData(0, 0, cols, rows);
    return pixelsToAscii(data.data, cols, rows);
  } catch {
    return null;
  }
}
