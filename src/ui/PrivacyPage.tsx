// The /privacy page: what is read, where it goes, what is stored, and how to delete it. Short and plain.
import { APP_NAME, REPO_URL } from '../lib/brand'
import { STORE_KEY, THEME_KEY } from '../lib/store'
import { ExternalLink } from './Link'

export function PrivacyPage() {
  return (
    <article className="prose">
      <h1>Privacy</h1>
      <p className="lead">
        {APP_NAME} has no accounts, no server code, no database, no analytics and no third-party scripts. Your grades
        never touch our server.
      </p>

      <h2>What is read</h2>
      <p>
        When you click the Sync button on canvas.cmu.edu, gradescope.com or autolab.andrew.cmu.edu, it reads your own
        courses, assignments, scores and letter cutoffs using the session you are already logged in with. It does not
        read messages, files, classmates or anything else, and it never submits, changes or opens an assignment.
      </p>
      <ul>
        <li>Canvas: Canvas's official REST API (the same one Canvas's own pages use).</li>
        <li>
          Gradescope and Autolab have no student API, so it reads the same course pages you would open yourself, one at
          a time, with a pause between them.
        </li>
      </ul>

      <h2>Where it goes</h2>
      <p>
        The Sync button sends your grades back to this page in the part of the URL after the <code>#</code>. Browsers
        never send that part to any server. This page reads it, saves it in your browser and removes it from the
        address bar and history right away.
      </p>

      <h2>What is stored</h2>
      <p>Only in your browser's local storage, under these keys:</p>
      <ul>
        <li>
          <code>{STORE_KEY}</code>: your synced grades, settings and what-ifs.
        </li>
        <li>
          <code>{THEME_KEY}</code>: light or dark mode, if you picked one.
        </li>
      </ul>

      <h2>Why no passwords or tokens</h2>
      <p>
        We never ask for your Andrew password: sharing it breaks CMU computing policy, and Duo would block it anyway. We
        also don't ask for a Canvas access token, because Canvas's API policy doesn't allow apps to collect them. The
        Sync button simply uses the login you already have open.
      </p>

      <h2>Deleting everything</h2>
      <p>
        Open Settings (the gear) and click Delete everything. Clearing this site's data in your browser does the same.
      </p>

      <h2>Not official</h2>
      <p>
        {APP_NAME} is an independent student project. It is not affiliated with or endorsed by Carnegie Mellon
        University, Instructure (Canvas), Turnitin (Gradescope) or the Autolab project. Grades, QPA and Dean's List
        checks are estimates; your official record is in SIO.
      </p>

      <h2>Open source</h2>
      <p>
        All the code is on <ExternalLink href={REPO_URL}>GitHub</ExternalLink>. Questions or problems? Open an issue
        there.
      </p>
    </article>
  )
}
