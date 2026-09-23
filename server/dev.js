process.env.PORT ||= '3001';
process.env.DEV_LOGIN = '1';
process.env.PUBLIC_ORIGIN ||= 'http://127.0.0.1:5173';
await import('./index.js');
