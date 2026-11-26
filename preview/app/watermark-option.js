'use client';

import { useRef } from 'react';
import styles from './watermark-option.module.css';

function SampleFrame({ branded = false }) {
  return <figure className={styles.sample}>
    <div className={styles.frame} aria-hidden="true">
      {branded && <span className={styles.mark}>PASS THE MOVIE</span>}
      <span className={styles.end}>Fin.</span>
    </div>
    <figcaption>{branded ? 'With watermark' : 'Without watermark'}</figcaption>
  </figure>;
}

export default function WatermarkOption() {
  const dialog = useRef(null);

  return <div className={styles.option}>
    <button type="button" className={styles.offer} onClick={() => dialog.current.showModal()} aria-haspopup="dialog">
      <span className={styles.icon} aria-hidden="true">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
          <path d="M3 11h18v9H3zM3 7l16.8-4.5 1 3.8L4 10.8zM7.4 5.8l2.9 3.3m2.3-4.7 2.9 3.3"/>
        </svg>
      </span>
      <span className={styles.copy}><strong>Remove watermark</strong><small>Optional paid upgrade</small></span>
      <span className={styles.chevron} aria-hidden="true">›</span>
    </button>
    <dialog ref={dialog} className={styles.dialog} aria-label="Remove watermark">
      <h2>Remove watermark</h2>
      <p className={styles.intro}>See how your movie would look without the Pass the Movie mark.</p>
      <div className={styles.samples} aria-label="Example frames"><SampleFrame branded/><SampleFrame/></div>
      <p className={styles.note}>Watermark removal is a paid option. Checkout is coming soon.</p>
      <button type="button" className={styles.checkout} disabled>Continue to payment</button>
      <form method="dialog"><button type="submit" className="ptm-secondary" autoFocus>Continue for free</button></form>
    </dialog>
  </div>;
}
