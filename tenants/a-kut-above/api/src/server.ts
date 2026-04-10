import app from './app';
import { env } from './config/env';

const PORT = env.PORT;

app.listen(PORT, () => {
  console.log(`A Kut Above API running on port ${PORT}`);
  console.log(`Environment: ${env.NODE_ENV}`);
});
