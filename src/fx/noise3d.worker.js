import { generateCloudNoiseData } from './noise3dData.js';

self.onmessage = (e) => {
  const data = generateCloudNoiseData(e.data);
  self.postMessage(data.buffer, [data.buffer]);
};
