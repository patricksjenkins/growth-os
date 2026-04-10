import { Request, Response, NextFunction } from 'express';

export class AppError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number = 500) {
    super(message);
    this.statusCode = statusCode;
  }
}

export const errorHandler = (err: Error, req: Request, res: Response, _next: NextFunction) => {
  console.error('Error:', err.message);

  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ success: false, error: err.message });
  }

  res.status(500).json({ success: false, error: 'Internal server error' });
};
