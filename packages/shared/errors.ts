export interface ErrorDetail {
  field: string;
  message: string;
}

export class ApiError extends Error {
  status: number;
  code: string;
  details: ErrorDetail[];

  constructor(status: number, code: string, message: string, details: ErrorDetail[] = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const validationError = (details: ErrorDetail[], message = 'Invalid request body') =>
  new ApiError(400, 'VALIDATION_ERROR', message, details);
export const notFound = (message = 'Not found') => new ApiError(404, 'NOT_FOUND', message);
export const conflictError = (message: string, details: ErrorDetail[] = []) => new ApiError(409, 'CONFLICT', message, details);
export const unauthorized = (message = 'Unauthorized') => new ApiError(401, 'UNAUTHORIZED', message);
export const badRequest = (message: string, details: ErrorDetail[] = []) => new ApiError(400, 'BAD_REQUEST', message, details);
