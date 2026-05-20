import { QueuePage } from './components/QueuePage';

// Static pre-launch entry. Renders QueuePage's educational content (hero
// spectrum, hydrogen line, Doppler animation, stars) with the queue UI
// suppressed and a "Coming Soon" header. No network calls, no Turnstile.
export default function PreLaunchPage() {
  return (
    <QueuePage
      mode="pre-launch"
      status={null}
      joining={false}
      joinError={null}
      siteKey={null}
      turnstileEnabled={false}
      betaPasswordEnabled={false}
      onJoin={async () => { /* unreachable in pre-launch mode */ }}
      hasControl={false}
      onContinue={() => { /* unreachable in pre-launch mode */ }}
      loading={false}
    />
  );
}
