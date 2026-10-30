import { googleFetch } from "./google-api.js";
import { escapeDriveQuery, truncate } from "./text.js";

const MAX_MEDIA_BYTES = 5 * 1024 * 1024;

export interface DriveApiContext {
  base: string;
  token: string;
}

export interface DriveSearchArgs {
  query: string;
  max_results?: number;
}

export interface DriveFileMetadata {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
  size?: string;
}

export async function driveSearch(
  api: DriveApiContext,
  args: DriveSearchArgs
): Promise<DriveFileMetadata[]> {
  const base = api.base.replace(/\/+$/, "");
  const url = new URL(`${base}/drive/v3/files`);
  const escaped = escapeDriveQuery(args.query);
  url.searchParams.set(
    "q",
    `fullText contains '${escaped}' and trashed = false`
  );
  if (args.max_results !== undefined) {
    url.searchParams.set("pageSize", String(args.max_results));
  }
  url.searchParams.set(
    "fields",
    "files(id,name,mimeType,modifiedTime,webViewLink)"
  );

  const res = await googleFetch(url.toString(), api.token);
  const data = (await res.json()) as { files?: DriveFileMetadata[] };
  return data.files ?? [];
}

export interface DriveReadArgs {
  file_id: string;
}

export interface DriveReadResult extends DriveFileMetadata {
  content?: string;
  content_truncated?: boolean;
  note?: string;
}

export async function driveRead(
  api: DriveApiContext,
  args: DriveReadArgs
): Promise<DriveReadResult> {
  const base = api.base.replace(/\/+$/, "");
  const metaUrl = `${base}/drive/v3/files/${encodeURIComponent(args.file_id)}?fields=id,name,mimeType,modifiedTime,webViewLink,size`;

  const metaRes = await googleFetch(metaUrl, api.token);
  const metadata = (await metaRes.json()) as DriveFileMetadata;

  let exportMime: string | null = null;
  let isMedia = false;

  if (metadata.mimeType === "application/vnd.google-apps.document") {
    exportMime = "text/plain";
  } else if (metadata.mimeType === "application/vnd.google-apps.spreadsheet") {
    exportMime = "text/csv";
  } else if (metadata.mimeType === "application/vnd.google-apps.presentation") {
    exportMime = "text/plain";
  } else if (
    metadata.mimeType.startsWith("text/") ||
    metadata.mimeType === "application/json"
  ) {
    isMedia = true;
  }

  if (exportMime) {
    const exportUrl = `${base}/drive/v3/files/${encodeURIComponent(args.file_id)}/export?mimeType=${encodeURIComponent(exportMime)}`;
    const contentRes = await googleFetch(exportUrl, api.token);
    const rawContent = await contentRes.text();
    const { text: content, truncated: content_truncated } = truncate(
      rawContent,
      50000
    );
    return {
      ...metadata,
      content,
      content_truncated,
    };
  }

  // alt=media downloads the whole file before we truncate it; skip big ones.
  if (isMedia && Number(metadata.size ?? 0) > MAX_MEDIA_BYTES) {
    return {
      ...metadata,
      note: `Archivo demasiado grande para leerlo (${metadata.size} bytes). Se devuelven solo metadatos.`,
    };
  }

  if (isMedia) {
    const mediaUrl = `${base}/drive/v3/files/${encodeURIComponent(args.file_id)}?alt=media`;
    const contentRes = await googleFetch(mediaUrl, api.token);
    const rawContent = await contentRes.text();
    const { text: content, truncated: content_truncated } = truncate(
      rawContent,
      50000
    );
    return {
      ...metadata,
      content,
      content_truncated,
    };
  }

  return {
    ...metadata,
    note: `Tipo de archivo no soportado para lectura directa (${metadata.mimeType}). Se devuelven solo metadatos.`,
  };
}
