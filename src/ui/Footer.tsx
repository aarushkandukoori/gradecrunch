// Footer on every page: the "not official" disclaimer plus GitHub and Privacy links.
import { APP_NAME, REPO_URL } from '../lib/brand'
import { ExternalLink, NavLink, type Navigate } from './Link'

export function Footer({ navigate }: { navigate: Navigate }) {
  return (
    <footer className="footer">
      <div className="container footer-inner">
        <p>
          {APP_NAME} is a student project, not affiliated with Carnegie Mellon University. Grades here are estimates;
          your official grades live in SIO.
        </p>
        <nav className="footer-links" aria-label="Footer">
          <ExternalLink href={REPO_URL}>GitHub</ExternalLink>
          <NavLink to="privacy" navigate={navigate}>
            Privacy
          </NavLink>
          <NavLink to="setup" navigate={navigate}>
            Setup
          </NavLink>
        </nav>
      </div>
    </footer>
  )
}
