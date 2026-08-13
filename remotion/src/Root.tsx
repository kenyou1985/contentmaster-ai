import { RemotionInputShot, RemotionInputConfig } from './types';

export default function Root({
  shots = [],
  config = {} as RemotionInputConfig,
}: {
  shots?: RemotionInputShot[];
  config?: RemotionInputConfig;
}) {
  return (
    <div style={{ flex: 1, backgroundColor: '#000' }}>
      <p style={{ color: '#888', padding: 12 }}>
        ContentMaster AI Remotion Root — use the MyVideo composition below.
      </p>
    </div>
  );
}
