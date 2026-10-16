// 1x1 transparent GIF + unsubscribe confirmation/error HTML.
// Subset-disciplined: no template literals with expressions, no
// multi-line string concatenation that scriptc can't see through.

export const PIXEL_GIF: Uint8Array = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00,
  0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00,
  0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
  0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
]);

export const UNSUB_PAGE_OK: string =
  "<!doctype html><html><head><meta charset=\"utf-8\"><title>Unsubscribed</title></head>" +
  "<body style=\"font-family:system-ui;max-width:32rem;margin:4rem auto;text-align:center\">" +
  "<h1>You are unsubscribed</h1><p>You will not receive any more emails from this newsletter.</p>" +
  "</body></html>";

export const UNSUB_PAGE_BAD: string =
  "<!doctype html><html><head><meta charset=\"utf-8\"><title>Invalid link</title></head>" +
  "<body style=\"font-family:system-ui;max-width:32rem;margin:4rem auto;text-align:center\">" +
  "<h1>This link is not valid</h1><p>It may have expired or been copied incompletely.</p>" +
  "</body></html>";