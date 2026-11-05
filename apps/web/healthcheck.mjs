const response = await fetch('http://127.0.0.1:3000/api/health/ready').catch(() => null);
process.exit(response?.ok ? 0 : 1);
