import { ApiError, badRequest } from '../shared/errors.ts';
import { config } from '../shared/config.ts';

const SUPPORTED_STRATEGIES = new Set(['auto', 'fast', 'hi_res', 'ocr_only']);

export interface DocumentExtractionInput {
  file: Buffer;
  filename: string;
  contentType: string;
  strategy?: string | null;
  languages?: string[];
}

export interface DocumentExtractionResult {
  text: string;
  metadata: {
    extractor: 'unstructured';
    filename: string;
    content_type: string;
    strategy: string;
    languages: string[];
    element_count: number;
    page_count: number | null;
  };
}

function unstructuredElements(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload))
    return payload.filter((entry): entry is Record<string, unknown> => entry != null && typeof entry === 'object');
  if (payload && typeof payload === 'object' && Array.isArray((payload as { elements?: unknown[] }).elements)) {
    return (payload as { elements: unknown[] }).elements.filter(
      (entry): entry is Record<string, unknown> => entry != null && typeof entry === 'object'
    );
  }
  return [];
}

export function textFromUnstructuredResponse(payload: unknown): { text: string; elementCount: number; pageCount: number | null } {
  const elements = unstructuredElements(payload);
  const parts: string[] = [];
  const pages = new Set<number>();

  for (const element of elements) {
    const text = typeof element.text === 'string' ? element.text.trim() : '';
    if (text) parts.push(text);

    const metadata = element.metadata;
    if (metadata && typeof metadata === 'object') {
      const pageNumber = (metadata as { page_number?: unknown }).page_number;
      if (typeof pageNumber === 'number' && Number.isFinite(pageNumber)) pages.add(pageNumber);
    }
  }

  return {
    text: parts.join('\n\n').trim(),
    elementCount: elements.length,
    pageCount: pages.size ? pages.size : null
  };
}

export async function extractDocumentText(input: DocumentExtractionInput): Promise<DocumentExtractionResult> {
  if (!input.file.length) throw badRequest('uploaded file is empty');
  const strategy = input.strategy && SUPPORTED_STRATEGIES.has(input.strategy) ? input.strategy : config.unstructuredStrategy;
  const languages = input.languages?.length ? input.languages : config.unstructuredLanguages;
  const form = new FormData();
  form.append('files', new Blob([input.file], { type: input.contentType || 'application/octet-stream' }), input.filename);
  form.append('strategy', strategy);
  for (const language of languages) form.append('languages', language);

  let response: Response;
  try {
    response = await fetch(config.unstructuredApiUrl, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        ...(config.unstructuredApiKey ? { 'unstructured-api-key': config.unstructuredApiKey } : {})
      },
      body: form,
      signal: AbortSignal.timeout(config.unstructuredTimeoutMs)
    });
  } catch (error) {
    throw new ApiError(502, 'DOCUMENT_EXTRACTION_FAILED', `Unstructured request failed: ${(error as Error).message}`);
  }

  const responseText = await response.text();
  if (!response.ok) {
    throw new ApiError(502, 'DOCUMENT_EXTRACTION_FAILED', `Unstructured returned ${response.status}: ${responseText.slice(0, 500)}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new ApiError(502, 'DOCUMENT_EXTRACTION_FAILED', 'Unstructured returned a non-JSON response');
  }

  const { text, elementCount, pageCount } = textFromUnstructuredResponse(payload);
  if (!text) throw new ApiError(502, 'DOCUMENT_EXTRACTION_FAILED', 'Unstructured did not extract any text from the document');

  return {
    text,
    metadata: {
      extractor: 'unstructured',
      filename: input.filename,
      content_type: input.contentType,
      strategy,
      languages,
      element_count: elementCount,
      page_count: pageCount
    }
  };
}
