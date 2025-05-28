import request from 'supertest';
import app from '../src/index';

describe('/ping input parameters', () => {
  const API_SECRET = process.env.API_SECRET || 'default-secret-key';

  it('should return 401 if secret is missing', async () => {
    const res = await request(app)
      .post('/ping')
      .send({ chain: 'Solana', check: true, env: 'dev' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('should return 400 if chain is missing', async () => {
    const res = await request(app)
      .post('/ping')
      .set('x-api-secret', API_SECRET)
      .send({ check: true, env: 'dev' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing chain parameter');
  });

  it('should return 400 if chain is unsupported', async () => {
    const res = await request(app)
      .post('/ping')
      .set('x-api-secret', API_SECRET)
      .send({ chain: 'unsupported', check: true, env: 'dev' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch('Unsupported chain');
  });

  it('should return 400 if env is missing', async () => {
    const res = await request(app)
      .post('/ping')
      .set('x-api-secret', API_SECRET)
      .send({ chain: 'Solana', check: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid or missing environment parameter');
  });

  it('should return 400 if env is invalid', async () => {
    const res = await request(app)
      .post('/ping')
      .set('x-api-secret', API_SECRET)
      .send({ chain: 'Solana', check: true, env: 'invalid' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid or missing environment parameter');
  });

  it('should return 400 if check is missing', async () => {
    const res = await request(app)
      .post('/ping')
      .set('x-api-secret', API_SECRET)
      .send({ chain: 'Solana', env: 'dev' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing check parameter');
  });

  it('should return 400 if check is not a boolean', async () => {
    const res = await request(app)
      .post('/ping')
      .set('x-api-secret', API_SECRET)
      .send({ chain: 'Solana', env: 'dev', check: 'not a boolean value' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid check parameter: must be boolean');
  });
});
