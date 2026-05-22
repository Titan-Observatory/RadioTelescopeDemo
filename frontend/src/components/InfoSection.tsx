import { track } from '../analytics';

const PLANNED_FEATURES = [
  'Multi-user scheduling — reserve observation windows days in advance',
  'RA/Dec & object-name GoTo — point at Andromeda by name',
  'Pulsar timing — detect rotational slow-down of known pulsars',
  'Hydrogen-line mapping — image the galactic plane in 21 cm',
  'Interferometry baseline — phase-coherent linking of multiple dishes',
  'Real-time sky subtraction & RFI excision pipeline',
  'Educational live-stream mode with annotated overlays',
  'Automated nightly observation queue with public data archive',
];

export function InfoSection() {
  return (
    <section className="info-section">
      <div className="info-section-inner">

        <div className="info-col info-col-about">
          <h2 className="info-col-heading">About this demo</h2>
          <p>
            Titan Observatory is building an online radio observatory with the goal of allowing anyone to perform and understand their own observations of the universe. This demo is intended to serve as a proof-of-concept for the remote observation platform and highlight the potential to create immersive and accessible experiences, which take care of the complexity and allow the user the freedom to explore.
          </p>

        </div>

        <div className="info-col info-col-features">
          <h2 className="info-col-heading">Roadmap</h2>
          <p>
            It doesnt stop here. Through your generous contributions and partnerships, we hope to found a permenant home for the observatory, expand capacity with more dishes, and create a rich ecosystem of features and educational content that makes radio astronomy more accessible than ever before.
          </p>
          <ul className="feature-list">
            {PLANNED_FEATURES.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </div>

        <div className="info-col info-col-donate">
          <h2 className="info-col-heading">Support the observatory</h2>
          <p>
            Titan Observatory runs entirely on community donations. Every dollar goes
            toward hardware, hosting, and expanding capacity — more dishes, more bandwidth,
            more time online for everyone.
          </p>
          <ul className="donate-impact-list">
            <li><strong>$10</strong> keeps the server running for a week</li>
            <li><strong>$50</strong> funds a new low-noise amplifier</li>
            <li><strong>$250</strong> contributes toward a second dish</li>
          </ul>
          <a
            className="donate-cta"
            href="https://titanobservatory.org/donate"
            target="_blank"
            rel="noreferrer"
            onClick={() => track('donate_clicked')}
          >
            Donate to Titan Observatory
          </a>
          <p className="info-note">
            Titan Observatory is a volunteer-run project. All contributions are
            used directly for observatory operations and development.
          </p>
        </div>

      </div>
    </section>
  );
}
