import request from 'supertest';
import { app, server } from '../src/index';

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

  it('positive: Solana, dev, no check', async () => {
    const res = await request(app)
      .post('/ping')
      .set('x-api-secret', API_SECRET)
      .send({ chain: 'Solana', check: false, env: 'dev' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('signatureRequest');
    expect(res.body.signatureRequest).toHaveProperty('txHash');
    expect(res.body.signatureRequest).toHaveProperty('requestId');
  }, 10000);

  it('positive: Solana, testnet, no check', async () => {
    const res = await request(app)
      .post('/ping')
      .set('x-api-secret', API_SECRET)
      .send({ chain: 'Solana', check: false, env: 'testnet' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('signatureRequest');
    expect(res.body.signatureRequest).toHaveProperty('txHash');
    expect(res.body.signatureRequest).toHaveProperty('requestId');
  }, 10000);

  it('positive: simultenious requests Solana', async () => {
    const requests = Array.from({ length: 10 }, () =>
      request(app)
        .post('/ping')
        .set('x-api-secret', API_SECRET)
        .send({ chain: 'Solana', check: false, env: 'dev' })
    );

    const responses = await Promise.all(requests);
    responses.forEach(res => {
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('signatureRequest');
      expect(res.body.signatureRequest).toHaveProperty('txHash');
      expect(res.body.signatureRequest).toHaveProperty('requestId');
    });
  }, 10000);

  it('positive: simultaneous requests Ethereum', async () => {
    const requests = Array.from({ length: 5 }, () =>
      request(app)
        .post('/ping')
        .set('x-api-secret', API_SECRET)
        .send({ chain: 'Ethereum', check: false, env: 'dev' })
    );

    const responses = await Promise.all(requests);
    responses.forEach(res => {
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('signatureRequest');
      expect(res.body.signatureRequest).toHaveProperty('txHash');
      expect(res.body.signatureRequest).toHaveProperty('requestId');
    });
  }, 10000);

  it('positive: Solana, dev, with check', async () => {
    const res = await request(app)
      .post('/ping')
      .set('x-api-secret', API_SECRET)
      .send({ chain: 'Solana', check: true, env: 'dev' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('signature');
  }, 10000);

  it.only('positive: Ethereum, testnet, no check', async () => {
    const res = await request(app)
      .post('/ping')
      .set('x-api-secret', API_SECRET)
      .send({ chain: 'Ethereum', check: false, env: 'testnet' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('signatureRequest');
    expect(res.body.signatureRequest).toHaveProperty('txHash');
    expect(res.body.signatureRequest).toHaveProperty('requestId');
  }, 10000);

  it('negative: Ethereum, dev, with check (must fail, unsupported)', async () => {
    const res = await request(app)
      .post('/ping')
      .set('x-api-secret', API_SECRET)
      .send({ chain: 'Ethereum', check: true, env: 'testnet' });

    console.log('Response body:', res.body);

    expect(res.status).toBe(500);
    expect(res.body.details).toBe(
      'Ethereum can not be called with check=true due to long finalization time'
    );
  }, 10000);
});

describe('/ health check', () => {
  const API_SECRET = process.env.API_SECRET || 'default-secret-key';

  it('should return a 200 status', async () => {
    const res = await request(app).get('/').set('x-api-secret', API_SECRET);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('OK');
    expect(res.body.supportedChains).toContain('Solana');
    expect(res.body.supportedChains).toContain('Ethereum');
  });
});

describe('/eth_balance endpoint', () => {
  const API_SECRET = process.env.API_SECRET || 'default-secret-key';
  const validAddress = '0x0000000000000000000000000000000000000000'; // always valid, always 0 balance

  it('should return 400 if address is missing', async () => {
    const res = await request(app)
      .post('/eth_balance')
      .set('x-api-secret', API_SECRET)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing address/);
  });

  it('should return 400 if address is invalid', async () => {
    const res = await request(app)
      .post('/eth_balance')
      .set('x-api-secret', API_SECRET)
      .send({ address: 'notanaddress' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid Ethereum address/);
  });

  it('should return a balance for a valid address (sepolia)', async () => {
    const res = await request(app)
      .post('/eth_balance')
      .set('x-api-secret', API_SECRET)
      .send({ address: validAddress });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('balance');
    expect(typeof res.body.balance).toBe('string');
    expect(Number(res.body.balance)).toBeGreaterThanOrEqual(0); // balance should be a number
    expect(res.body).not.toHaveProperty('error');
  });

  it('should return a balance for a valid address (mainnet)', async () => {
    const res = await request(app)
      .post('/eth_balance')
      .set('x-api-secret', API_SECRET)
      .send({ address: validAddress, env: 'mainnet' });
    // 200 or 500 if no mainnet RPC, but should not be 400
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body).toHaveProperty('balance');
      expect(typeof res.body.balance).toBe('string');
      expect(Number(res.body.balance)).toBeGreaterThanOrEqual(0); // balance should be a number
      expect(res.body).not.toHaveProperty('error');
    }
  });
});

afterAll(done => {
  server.close(done);
});
