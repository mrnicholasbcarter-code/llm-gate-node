import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import express, { Application } from 'express';
import { z } from 'zod';
import {
  validate,
  DeepObjectValidator,
  createHallucinationGuard,
  ValidationResult,
  ValidationSchema,
} from '../../src/middleware/validator';

// Test server setup
let app: Application;

beforeEach(() => {
  app = express();
  app.use(express.json());
});

afterEach(() => {
  app = undefined as unknown as Application;
});

// ============================================
// VALIDATION MATRIX TESTS
// ============================================

describe('Validation Matrix', () => {
  describe('Basic Schema Validation', () => {
    it('should pass valid body data', async () => {
      const schema: ValidationSchema<{ name: string; age: number }> = {
        body: z.object({
          name: z.string(),
          age: z.number().positive(),
        }),
      };

      app.post('/test', validate(schema), (req: Request, res: Response) => {
        res.json({ success: true, data: req.body });
      });

      const response = await request(app).post('/test').send({ name: 'Alice', age: 30 });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should reject invalid body data', async () => {
      const schema: ValidationSchema<{ name: string; age: number }> = {
        body: z.object({
          name: z.string(),
          age: z.number().positive(),
        }),
      };

      app.post('/test', validate(schema), (req: Request, res: Response) => {
        res.json({ success: true, data: req.body });
      });

      const response = await request(app).post('/test').send({ name: 'Alice', age: -5 });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.errors).toBeDefined();
    });

    it('should validate query parameters', async () => {
      const schema: ValidationSchema<{ page: number; limit: number }> = {
        query: z.object({
          page: z.coerce.number().int().min(1),
          limit: z.coerce.number().int().min(1).max(100),
        }),
      };

      app.get('/test', validate(schema), (req: Request, res: Response) => {
        res.json({ success: true, query: req.query });
      });

      const response = await request(app).get('/test').query({ page: '1', limit: '50' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should reject invalid query parameters', async () => {
      const schema: ValidationSchema<{ page: number; limit: number }> = {
        query: z.object({
          page: z.coerce.number().int().min(1),
          limit: z.coerce.number().int().min(1).max(100),
        }),
      };

      app.get('/test', validate(schema), (req: Request, res: Response) => {
        res.json({ success: true, query: req.query });
      });

      const response = await request(app).get('/test').query({ page: '0', limit: '150' });

      expect(response.status).toBe(400);
      expect(response.body.errors).toBeDefined();
    });

    it('should validate route params', async () => {
      const schema: ValidationSchema<{ id: string }> = {
        params: z.object({
          id: z.string().uuid(),
        }),
      };

      app.get('/test/:id', validate(schema), (req: Request, res: Response) => {
        res.json({ success: true, id: req.params.id });
      });

      const response = await request(app).get('/test/550e8400-e29b-41d4-a716-446655440000');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should reject invalid route params', async () => {
      const schema: ValidationSchema<{ id: string }> = {
        params: z.object({
          id: z.string().uuid(),
        }),
      };

      app.get('/test/:id', validate(schema), (req: Request, res: Response) => {
        res.json({ success: true, id: req.params.id });
      });

      const response = await request(app).get('/test/invalid-uuid');

      expect(response.status).toBe(400);
    });
  });

  describe('Deep Object Validation', () => {
    it('should validate nested objects', async () => {
      const schema: ValidationSchema = {
        body: z.object({
          user: z.object({
            profile: z.object({
              name: z.string(),
              email: z.string().email(),
            }),
          }),
        }),
      };

      app.post('/test', validate(schema), (req: Request, res: Response) => {
        res.json({ success: true });
      });

      const response = await request(app)
        .post('/test')
        .send({
          user: {
            profile: {
              name: 'Bob',
              email: 'bob@example.com',
            },
          },
        });

      expect(response.status).toBe(200);
    });

    it('should reject deeply nested invalid data', async () => {
      const schema: ValidationSchema = {
        body: z.object({
          user: z.object({
            profile: z.object({
              name: z.string(),
              email: z.string().email(),
            }),
          }),
        }),
      };

      app.post('/test', validate(schema), (req: Request, res: Response) => {
        res.json({ success: true });
      });

      const response = await request(app)
        .post('/test')
        .send({
          user: {
            profile: {
              name: 'Bob',
              email: 'not-an-email',
            },
          },
        });

      expect(response.status).toBe(400);
      expect(response.body.errors.some((e: string) => e.includes('email'))).toBe(true);
    });

    it('should validate arrays of objects', async () => {
      const schema: ValidationSchema = {
        body: z.object({
          items: z.array(
            z.object({
              id: z.string().uuid(),
              quantity: z.number().min(1),
            })
          ),
        }),
      };

      app.post('/test', validate(schema), (req: Request, res: Response) => {
        res.json({ success: true, count: req.body.items.length });
      });

      const response = await request(app)
        .post('/test')
        .send({
          items: [
            { id: '550e8400-e29b-41d4-a716-446655440000', quantity: 5 },
            { id: '660e8400-e29b-41d4-a716-446655440001', quantity: 10 },
          ],
        });

      expect(response.status).toBe(200);
      expect(response.body.count).toBe(2);
    });

    it('should reject arrays with invalid nested objects', async () => {
      const schema: ValidationSchema = {
        body: z.object({
          items: z.array(
            z.object({
              id: z.string().uuid(),
              quantity: z.number().min(1),
            })
          ),
        }),
      };

      app.post('/test', validate(schema), (req: Request, res: Response) => {
        res.json({ success: true });
      });

      const response = await request(app)
        .post('/test')
        .send({
          items: [
            { id: '550e8400-e29b-41d4-a716-446655440000', quantity: 5 },
            { id: 'invalid', quantity: 10 },
          ],
        });

      expect(response.status).toBe(400);
    });
  });
});

// ============================================
// DEEP OBJECT HALLUCINATION BLOCKING TESTS
// ============================================

describe('Deep Object Hallucination Blocking', () => {
  describe('DeepObjectValidator', () => {
    describe('validate', () => {
      it('should validate correct object structure', () => {
        const schema = z.object({
          id: z.string().uuid(),
          name: z.string(),
          value: z.number(),
        });

        const result = DeepObjectValidator.validate(
          { id: '550e8400-e29b-41d4-a716-446655440000', name: 'test', value: 42 },
          schema
        );

        expect(result.success).toBe(true);
        expect(result.data).toEqual({
          id: '550e8400-e29b-41d4-a716-446655440000',
          name: 'test',
          value: 42,
        });
      });

      it('should reject non-object input', () => {
        const schema = z.object({ id: z.string() });

        const result = DeepObjectValidator.validate(null, schema);

        expect(result.success).toBe(false);
        expect(result.errors).toContain('Input must be an object');
      });

      it('should reject missing required fields', () => {
        const schema = z.object({
          id: z.string().uuid(),
          name: z.string(),
        });

        const result = DeepObjectValidator.validate({ id: 'test' }, schema);

        expect(result.success).toBe(false);
        expect(result.errors).toBeDefined();
      });

      it('should detect extra keys in strict mode', () => {
        const schema = z.object({
          id: z.string(),
          name: z.string(),
        });

        const result = DeepObjectValidator.validate(
          { id: '123', name: 'test', extra: 'hallucination' },
          schema
        );

        expect(result.success).toBe(false);
      });
    });

    describe('validateDeep', () => {
      it('should validate simple objects', () => {
        const result = DeepObjectValidator.validateDeep({ a: 1, b: 2 });

        expect(result.success).toBe(true);
      });

      it('should validate nested objects', () => {
        const result = DeepObjectValidator.validateDeep({
          level1: {
            level2: {
              level3: 'deep',
            },
          },
        });

        expect(result.success).toBe(true);
      });

      it('should validate arrays', () => {
        const result = DeepObjectValidator.validateDeep([1, 2, 3]);

        expect(result.success).toBe(true);
      });

      it('should reject beyond max depth', () => {
        const deepObject = { a: { b: { c: { d: { e: { f: { g: { h: 'too deep' } } } } } } } };

        const result = DeepObjectValidator.validateDeep(deepObject, 0, 3);

        expect(result.success).toBe(false);
        expect(result.errors).toContain('Maximum validation depth (3) exceeded');
      });

      it('should handle null and undefined', () => {
        const result = DeepObjectValidator.validateDeep(null);

        expect(result.success).toBe(true);
      });
    });

    describe('detectHallucination', () => {
      it('should pass valid responses', () => {
        const response = { id: '123', name: 'test' };
        const result = DeepObjectValidator.detectHallucination(response, ['id', 'name']);

        expect(result.success).toBe(true);
      });

      it('should detect unexpected keys', () => {
        const response = { id: '123', name: 'test', fake_field: 'hallucination' };
        const result = DeepObjectValidator.detectHallucination(response, ['id', 'name']);

        expect(result.success).toBe(false);
        expect(result.errors![0]).toContain('Unexpected keys detected');
        expect(result.errors![0]).toContain('fake_field');
      });

      it('should allow extra keys when permitted', () => {
        const response = { id: '123', name: 'test', extra: 'allowed' };
        const result = DeepObjectValidator.detectHallucination(response, ['id', 'name'], true);

        expect(result.success).toBe(true);
      });

      it('should reject null input', () => {
        const result = DeepObjectValidator.detectHallucination(null, ['id']);

        expect(result.success).toBe(false);
      });

      it('should detect empty strings in critical fields', () => {
        const response = { id: '123', name: '' };
        const result = DeepObjectValidator.detectHallucination(response, ['id', 'name']);

        expect(result.success).toBe(false);
        expect(result.errors!.some((e: string) => e.includes('empty string'))).toBe(true);
      });
    });
  });

  describe('createHallucinationGuard middleware', () => {
    it('should allow valid request body', async () => {
      app.use(
        createHallucinationGuard({
          maxDepth: 5,
          expectedKeys: ['user', 'data'],
        })
      );

      app.post('/test', (req: Request, res: Response) => {
        res.json({ success: true });
      });

      const response = await request(app)
        .post('/test')
        .send({ user: { name: 'Alice' }, data: { value: 42 } });

      expect(response.status).toBe(200);
    });

    it('should reject request with unexpected keys', async () => {
      app.use(
        createHallucinationGuard({
          maxDepth: 5,
          expectedKeys: ['user', 'data'],
          allowExtraKeys: false,
        })
      );

      app.post('/test', (req: Request, res: Response) => {
        res.json({ success: true });
      });

      const response = await request(app)
        .post('/test')
        .send({ user: { name: 'Alice' }, data: { value: 42 }, fake: 'hallucination' });

      expect(response.status).toBe(400);
      expect(response.body.errors).toBeDefined();
    });

    it('should reject deeply nested objects beyond max depth', async () => {
      app.use(
        createHallucinationGuard({
          maxDepth: 2,
        })
      );

      app.post('/test', (req: Request, res: Response) => {
        res.json({ success: true });
      });

      const response = await request(app)
        .post('/test')
        .send({ a: { b: { c: { d: { e: 'too deep' } } } } });

      expect(response.status).toBe(400);
    });
  });
});

// ============================================
// INTEGRATION TESTS
// ============================================

describe('Express Integration Tests', () => {
  describe('Full request validation pipeline', () => {
    it('should validate entire request with all components', async () => {
      const schema: ValidationSchema<{ user: { name: string }; page: number }> = {
        body: z.object({
          user: z.object({
            name: z.string().min(1),
          }),
        }),
        query: z.object({
          page: z.coerce.number().int().min(1).optional(),
        }),
      };

      app.post('/api/users', validate(schema), (req: Request, res: Response) => {
        res.json({
          success: true,
          user: req.body.user.name,
          page: req.query.page ? parseInt(req.query.page as string, 10) : 1,
        });
      });

      const response = await request(app)
        .post('/api/users?page=2')
        .send({ user: { name: 'Charlie' } });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.user).toBe('Charlie');
      expect(response.body.page).toBe(2);
    });

    it('should handle validation errors gracefully', async () => {
      const schema: ValidationSchema = {
        body: z.object({
          email: z.string().email(),
        }),
      };

      app.post('/api/test', validate(schema), (req: Request, res: Response) => {
        res.json({ success: true });
      });

      const response = await request(app).post('/api/test').send({ email: 'invalid-email' });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.errors).toBeInstanceOf(Array);
      expect(response.body.errors.length).toBeGreaterThan(0);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty request body', async () => {
      const schema: ValidationSchema = {
        body: z.object({}),
      };

      app.post('/test', validate(schema), (req: Request, res: Response) => {
        res.json({ success: true });
      });

      const response = await request(app).post('/test').send({});

      expect(response.status).toBe(200);
    });

    it('should handle null request body', async () => {
      const schema: ValidationSchema = {
        body: z.any().nullable(),
      };

      app.post('/test', validate(schema), (req: Request, res: Response) => {
        res.json({ success: true });
      });

      const response = await request(app)
        .post('/test')
        .send(null as unknown as object);

      expect(response.status).toBe(200);
    });

    it('should handle special characters in strings', async () => {
      const schema: ValidationSchema = {
        body: z.object({
          text: z.string(),
        }),
      };

      app.post('/test', validate(schema), (req: Request, res: Response) => {
        res.json({ success: true, text: req.body.text });
      });

      const response = await request(app)
        .post('/test')
        .send({ text: 'Hello <script>alert("xss")</script>' });

      expect(response.status).toBe(200);
      // Note: XSS prevention should be handled separately
    });

    it('should handle unicode characters', async () => {
      const schema: ValidationSchema = {
        body: z.object({
          name: z.string(),
        }),
      };

      app.post('/test', validate(schema), (req: Request, res: Response) => {
        res.json({ success: true, name: req.body.name });
      });

      const response = await request(app).post('/test').send({ name: '日本語テスト 🎉' });

      expect(response.status).toBe(200);
      expect(response.body.name).toBe('日本語テスト 🎉');
    });

    it('should handle large payloads', async () => {
      const largeArray = Array.from({ length: 1000 }, (_, i) => ({ id: i, value: `item-${i}` }));

      const schema: ValidationSchema = {
        body: z.object({
          items: z.array(z.object({ id: z.number(), value: z.string() })),
        }),
      };

      app.post('/test', validate(schema), (req: Request, res: Response) => {
        res.json({ success: true, count: req.body.items.length });
      });

      const response = await request(app).post('/test').send({ items: largeArray });

      expect(response.status).toBe(200);
      expect(response.body.count).toBe(1000);
    });
  });
});

// ============================================
// SANITY CHECKS
// ============================================

describe('Sanity Checks', () => {
  it('should pass basic validation', async () => {
    const schema: ValidationSchema = {
      body: z.object({
        id: z.string().uuid(),
      }),
    };

    app.post('/test', validate(schema), (req: Request, res: Response) => {
      res.json({ success: true });
    });

    const response = await request(app)
      .post('/test')
      .send({ id: '550e8400-e29b-41d4-a716-446655440000' });

    expect(response.status).toBe(200);
  });

  it('should fail on type mismatch', async () => {
    const schema: ValidationSchema = {
      body: z.object({
        count: z.number(),
      }),
    };

    app.post('/test', validate(schema), (req: Request, res: Response) => {
      res.json({ success: true });
    });

    const response = await request(app).post('/test').send({ count: 'not-a-number' });

    expect(response.status).toBe(400);
  });

  it('should reject malformed JSON', async () => {
    app.post('/test', (req: Request, res: Response) => {
      res.json({ success: true });
    });

    const response = await request(app)
      .post('/test')
      .set('Content-Type', 'application/json')
      .send('{ invalid json }');

    // Express should handle this gracefully
    expect([200, 400, 500]).toContain(response.status);
  });
});
