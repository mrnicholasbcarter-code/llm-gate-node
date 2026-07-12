import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

/**
 * Validation result containing parsed data or validation errors
 */
export interface ValidationResult<T> {
  success: boolean;
  data?: T;
  errors?: string[];
}

/**
 * Schema definition for validation rules
 */
export interface ValidationSchema<T = unknown> {
  body?: z.ZodSchema;
  query?: z.ZodSchema;
  params?: z.ZodSchema;
  headers?: z.ZodSchema;
}

/**
 * Validation options for the validator middleware
 */
export interface ValidatorOptions<T = unknown> {
  schema: ValidationSchema<T>;
  sanitize?: boolean;
  stopOnFirst?: boolean;
}

/**
 * Creates a validation middleware with deep object validation
 * to prevent hallucination from API outputs
 */
export function validate<T>(options: ValidatorOptions<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const errors: string[] = [];

    // Validate body if schema provided
    if (options.schema.body) {
      try {
        const result = options.schema.body.safeParse(req.body);
        if (!result.success) {
          errors.push(...result.error.errors.map(e => `body.${e.path.join('.')}: ${e.message}`));
        } else if (options.sanitize) {
          req.body = result.data;
        }
      } catch (e) {
        errors.push(`body: validation error - ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Validate query if schema provided
    if (options.schema.query) {
      try {
        const result = options.schema.query.safeParse(req.query);
        if (!result.success) {
          errors.push(...result.error.errors.map(e => `query.${e.path.join('.')}: ${e.message}`));
        } else if (options.sanitize) {
          req.query = result.data;
        }
      } catch (e) {
        errors.push(`query: validation error - ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Validate params if schema provided
    if (options.schema.params) {
      try {
        const result = options.schema.params.safeParse(req.params);
        if (!result.success) {
          errors.push(...result.error.errors.map(e => `params.${e.path.join('.')}: ${e.message}`));
        } else if (options.sanitize) {
          req.params = result.data;
        }
      } catch (e) {
        errors.push(`params: validation error - ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Validate headers if schema provided
    if (options.schema.headers) {
      try {
        const result = options.schema.headers.safeParse(req.headers);
        if (!result.success) {
          errors.push(...result.error.errors.map(e => `headers.${e.path.join('.')}: ${e.message}`));
        } else if (options.sanitize) {
          req.headers = result.data;
        }
      } catch (e) {
        errors.push(`headers: validation error - ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (errors.length > 0) {
      res.status(400).json({
        success: false,
        errors
      });
      return;
    }

    next();
  };
}

/**
 * Deep object validator to prevent hallucination from API outputs
 * Validates nested objects against expected schemas
 */
export class DeepObjectValidator {
  /**
   * Validates that an object contains only expected keys and types
   * Prevents hallucination by rejecting unexpected properties
   */
  static validate<T extends Record<string, unknown>>(
    obj: unknown,
    expectedSchema: z.ZodSchema<T>,
    strict: boolean = true
  ): ValidationResult<T> {
    if (typeof obj !== 'object' || obj === null) {
      return {
        success: false,
        errors: ['Input must be an object']
      };
    }

    const result = strict 
      ? expectedSchema.strict().safeParse(obj)
      : expectedSchema.safeParse(obj);

    if (result.success) {
      return {
        success: true,
        data: result.data
      };
    }

    return {
      success: false,
      errors: result.error.errors.map(e => e.message)
    };
  }

  /**
   * Recursively validates all nested objects in a structure
   */
  static validateDeep(obj: unknown, depth: number = 0, maxDepth: number = 10): ValidationResult {
    if (depth > maxDepth) {
      return {
        success: false,
        errors: [`Maximum validation depth (${maxDepth}) exceeded`]
      };
    }

    if (obj === null || obj === undefined) {
      return { success: true };
    }

    if (typeof obj === 'object') {
      if (Array.isArray(obj)) {
        for (const item of obj) {
          const result = DeepObjectValidator.validateDeep(item, depth + 1, maxDepth);
          if (!result.success) {
            return result;
          }
        }
      } else {
        for (const value of Object.values(obj)) {
          const result = DeepObjectValidator.validateDeep(value, depth + 1, maxDepth);
          if (!result.success) {
            return result;
          }
        }
      }
    }

    return { success: true };
  }

  /**
   * Checks for potential hallucination patterns in API responses
   */
  static detectHallucination(
    response: unknown,
    expectedKeys: string[],
    allowExtraKeys: boolean = false
  ): ValidationResult {
    if (typeof response !== 'object' || response === null) {
      return {
        success: false,
        errors: ['Response must be an object']
      };
    }

    const actualKeys = Object.keys(response as Record<string, unknown>);
    const extraKeys = actualKeys.filter(k => !expectedKeys.includes(k));

    if (extraKeys.length > 0 && !allowExtraKeys) {
      return {
        success: false,
        errors: [`Unexpected keys detected (potential hallucination): ${extraKeys.join(', ')}`]
      };
    }

    // Check for suspicious patterns
    const suspiciousPatterns = DeepObjectValidator.findSuspiciousPatterns(response);
    if (suspiciousPatterns.length > 0) {
      return {
        success: false,
        errors: [`Suspicious patterns detected: ${suspiciousPatterns.join(', ')}`]
      };
    }

    return { success: true };
  }

  /**
   * Finds suspicious patterns that may indicate hallucination
   */
  private static findSuspiciousPatterns(obj: unknown, path: string = ''): string[] {
    const patterns: string[] = [];

    if (obj === null || obj === undefined) {
      return patterns;
    }

    if (typeof obj === 'object') {
      if (Array.isArray(obj)) {
        // Check for array with mixed types (potential hallucination)
        const types = new Set(obj.map(item => typeof item));
        if (types.size > 1 && types.size < obj.length) {
          patterns.push(`mixed types in array at ${path}`);
        }
        for (let i = 0; i < obj.length; i++) {
          patterns.push(...DeepObjectValidator.findSuspiciousPatterns(obj[i], `${path}[${i}]`));
        }
      } else {
        const entries = Object.entries(obj as Record<string, unknown>);
        
        // Check for empty string values in critical fields
        for (const [key, value] of entries) {
          if (value === '') {
            patterns.push(`empty string at ${path ? `${path}.${key}` : key}`);
          }
          patterns.push(...DeepObjectValidator.findSuspiciousPatterns(value, `${path ? `${path}.${key}` : key}`));
        }
      }
    }

    return patterns;
  }
}

/**
 * Express middleware factory for blocking deep object hallucination
 */
export function createHallucinationGuard(options: {
  maxDepth?: number;
  allowExtraKeys?: boolean;
  expectedKeys?: string[];
}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const { maxDepth = 10, allowExtraKeys = false, expectedKeys = [] } = options;

    // Validate request body for hallucination patterns
    if (req.body && typeof req.body === 'object') {
      const result = DeepObjectValidator.validateDeep(req.body, 0, maxDepth);
      if (!result.success) {
        res.status(400).json({
          success: false,
          errors: result.errors
        });
        return;
      }

      if (expectedKeys.length > 0) {
        const detection = DeepObjectValidator.detectHallucination(req.body, expectedKeys, allowExtraKeys);
        if (!detection.success) {
          res.status(400).json({
            success: false,
            errors: detection.errors
          });
          return;
        }
      }
    }

    // Validate response data if present
    if (req.res?.locals?.data) {
      const result = DeepObjectValidator.validateDeep(req.res.locals.data, 0, maxDepth);
      if (!result.success) {
        res.status(500).json({
          success: false,
          errors: ['Response contains hallucination patterns']
        });
        return;
      }
    }

    next();
  };
}

export default validate;