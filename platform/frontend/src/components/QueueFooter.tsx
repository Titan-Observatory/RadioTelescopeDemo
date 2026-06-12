// Site footer ported from titan-observatory-dynamic's <Footer>, adapted to
// this app's Vite/React + plain-CSS stack (no Next.js, no Tailwind). The
// internal page-navigation columns and the Candid/GuideStar seal from the
// source are intentionally dropped — this app is the live telescope queue, not
// the marketing site — leaving the brand block, external community/social
// links, and the share row. Styling uses the existing palette variables so it
// matches the rest of the queue page.

import type { CSSProperties } from 'react';

const communityLinks = [
  { label: 'Forum', href: 'https://community.titanobservatory.org' },
  { label: 'Updates', href: 'https://community.titanobservatory.org/c/news-announcements' },
  { label: 'Learning Resources', href: 'https://community.titanobservatory.org/c/radio-astronomy' },
];

const followLinks = [
  { label: 'Mastodon', href: 'https://mastodon.social/@TitanObservatory', rel: 'me' },
  { label: 'X (Twitter)', href: 'https://x.com/TitanObservatry', rel: 'noreferrer' },
  { label: 'Reddit', href: 'https://www.reddit.com/r/TitanObservatory/', rel: 'noreferrer' },
];

const shareLinks = [
  {
    label: 'Share on X',
    href: 'https://twitter.com/intent/tweet?text=Check%20out%20the%20Titan%20Observatory%20project!%20https%3A%2F%2Ftitanobservatory.org',
    color: '#1DA1F2',
    icon: '/social/twitter.webp',
  },
  {
    label: 'Share on Facebook',
    href: 'https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Ftitanobservatory.org',
    color: '#3b5998',
    icon: '/social/facebook.webp',
  },
  {
    label: 'Share on LinkedIn',
    href: 'https://www.linkedin.com/sharing/share-offsite/?url=https%3A%2F%2Ftitanobservatory.org',
    color: '#0A66C2',
    icon: '/social/linkedin.webp',
  },
];

export function QueueFooter() {
  return (
    <footer className="titan-footer">
      <div className="titan-footer-main">
        <div className="titan-footer-brand">
          <p className="titan-footer-wordmark">
            <img src="/titan-logo.webp" alt="" width={26} height={26} />
            Titan Observatory
          </p>
          <p className="titan-footer-tagline">
            Enabling anyone to run real radio astronomy experiments using
            professional instrumentation.
          </p>
          <div className="titan-footer-contact">
            <p>
              Contact:&nbsp;
              <a href="mailto:contact@titanobservatory.org">contact@titanobservatory.org</a>
            </p>
            <p>Community HQ — Lakeland, FL</p>
            <p>EIN: 39-4885264</p>
          </div>
        </div>

        <div className="titan-footer-columns">
          <div className="titan-footer-col">
            <h3>Community</h3>
            <ul>
              {communityLinks.map((link) => (
                <li key={link.href}>
                  <a href={link.href} target="_blank" rel="noreferrer">{link.label}</a>
                </li>
              ))}
            </ul>
          </div>

          <div className="titan-footer-col">
            <h3>Follow Us</h3>
            <ul>
              {followLinks.map((link) => (
                <li key={link.href}>
                  <a
                    href={link.href}
                    rel={link.rel}
                    {...(link.rel === 'noreferrer' ? { target: '_blank' } : {})}
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          <div className="titan-footer-col titan-footer-col-share">
            <h3>Share Titan Observatory</h3>
            <div className="titan-footer-share">
              {shareLinks.map((link) => (
                <a
                  key={link.href}
                  className="titan-share-btn"
                  href={link.href}
                  target="_blank"
                  rel="noreferrer"
                  style={
                    {
                      '--share-color': link.color,
                      '--share-border': `${link.color}99`,
                      '--share-bg': `${link.color}26`,
                    } as CSSProperties
                  }
                >
                  <span
                    aria-hidden="true"
                    className="titan-share-icon"
                    style={{
                      maskImage: `url(${link.icon})`,
                      WebkitMaskImage: `url(${link.icon})`,
                    }}
                  />
                  {link.label}
                </a>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="titan-footer-bottom">
        <p>&copy; {new Date().getFullYear()} Titan Observatory. All rights reserved.</p>
        <p className="titan-footer-legal">
          <a href="https://titanobservatory.org/terms" target="_blank" rel="noreferrer">Terms</a>
          <a href="https://titanobservatory.org/privacy" target="_blank" rel="noreferrer">Privacy</a>
          <a href="https://community.titanobservatory.org/c/announcements" target="_blank" rel="noreferrer">Newsletter</a>
        </p>
      </div>
    </footer>
  );
}
