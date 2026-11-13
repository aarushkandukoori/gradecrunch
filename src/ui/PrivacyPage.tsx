// The /privacy page: what is read, where it goes, what is stored, and how to delete it. Short and plain.
// The AI advisor section must match what functions/api/chat.ts and the chat's first-use notice (ChatPanel.tsx) do.
import { APP_NAME, REPO_URL } from '../lib/brand'
import { CHAT_KEY, CONSENT_KEY, MEMORY_KEY } from '../lib/chat/memory'
import { AUTOLAB_SETTING_KEY } from '../lib/extension'
import { STORE_KEY, THEME_KEY } from '../lib/store'
import { ExternalLink } from './Link'

// OpenAI's page on what happens to data sent to its API (checked 2026-11-13: not used for training, abuse
// monitoring logs kept up to 30 days unless the law requires longer).
const OPENAI_DATA_URL = 'https://developers.openai.com/api/docs/guides/your-data'

export function PrivacyPage() {
  return (
    <article className="prose">
      <h1>Privacy</h1>
      <p className="lead">
        {APP_NAME} has no accounts, no database, no analytics and no third-party scripts. Your grades are saved only in
        your browser. The one time any of it leaves your browser is when you use the AI advisor, the optional AI chat.
      </p>

      <h2>What is read</h2>
      <p>
        When you click the Sync button on canvas.cmu.edu, gradescope.com or autolab.andrew.cmu.edu, it reads your own
        courses, assignments, scores and letter cutoffs using the session you are already logged in with. On Canvas it
        also reads each class's syllabus (the Syllabus page, the course home page and PDF files named like a syllabus),
        only to find the real grading weights. It does not read messages, other files, classmates or anything else,
        and it never submits, changes or opens an assignment.
      </p>
      <p>
        On SIO (s3.andrew.cmu.edu) it reads only your Grades and QPA page, for each semester: your courses, their units,
        grade option (letter or pass/fail), mid-semester and final grades, and your official QPA. That is how it knows
        exact units, which classes are pass/fail and your past semesters. It reads nothing else in SIO and changes
        nothing there.
      </p>
      <ul>
        <li>Canvas: Canvas's official REST API (the same one Canvas's own pages use).</li>
        <li>
          Gradescope, Autolab and SIO have no student API, so it reads the same pages you would open yourself, one at a
          time, with a pause between them.
        </li>
      </ul>

      <h2>Where it goes</h2>
      <p>
        The Sync button opens {APP_NAME} in a new tab and hands your grades straight to it, tab to tab, inside your
        browser. They are never put in a URL and never sent to a server. This page only accepts grades from the tab
        that opened it, and only when that tab is Canvas, Gradescope, Autolab or SIO.
      </p>
      <p>
        If your browser blocks the new tab (a popup blocker), the Sync button falls back to opening a link with your
        grades in the part after the <code>#</code>. Browsers never send that part to a server, and this page removes
        it from the address bar right away, but the link can stay in your browser history (and in history sync, if you
        have it turned on). To clear it, delete the {APP_NAME} entries from your browser history, or allow popups
        for Canvas, Gradescope, Autolab and SIO so it never happens.
      </p>

      <h2>Chrome extension</h2>
      <p>
        The {APP_NAME} Chrome extension does the same job as the Sync button without the bookmark: it reads the same
        grade data, from the same sites, using the login you already have open in Chrome. Before its first sync
        it shows a welcome screen explaining this, and it does nothing until you click Continue there.
      </p>
      <ul>
        <li>
          Access to canvas.cmu.edu, www.gradescope.com and autolab.andrew.cmu.edu: to read your own courses,
          assignments, scores and letter cutoffs there. It only reads; it never submits or changes anything.
        </li>
        <li>
          Access to s3.andrew.cmu.edu (SIO): to read your Grades and QPA page, as described above. It only reads.
        </li>
        <li>
          Optional access to inscloudgate.net (asked with a checkbox on the welcome screen): Canvas stores uploaded
          files there, so this lets the extension download your classes' syllabus PDFs to read the grading weights.
          Without it, everything else still works. The PDFs are turned into text in this page; the files themselves are
          never saved.
        </li>
        <li>
          Storage: to remember that you finished its welcome screen, and to keep a copy of your last synced grades
          inside the extension, on your computer. Removing the extension deletes it.
        </li>
        <li>
          Offscreen document: a hidden extension page where it reads Gradescope, Autolab and SIO pages, because the part
          of an extension that runs in the background cannot read web pages by itself.
        </li>
      </ul>
      <p>
        It hands your grades only to this website ({APP_NAME}), inside your browser. Chrome blocks other websites from
        asking it for them. It has no server, no analytics and no tracking, and it sends your grades nowhere else.
        This page stores them in your browser, as listed below. If you use the AI advisor, this page sends a summary of
        them to OpenAI, as described next.
      </p>
      <p>
        {APP_NAME}'s use of information received from Canvas, Gradescope, Autolab and SIO follows the Chrome Web Store
        User Data Policy, including the Limited Use requirements.
      </p>

      <h2>AI advisor (the AI chat)</h2>
      <p>
        The AI advisor is optional. It does nothing until you open it and accept a short notice. Each time you send a
        question, {APP_NAME} sends it through its own server to OpenAI, together with the recent chat, the notes the AI
        advisor saved about you and a summary of your grades. That is the only server code {APP_NAME} has.
      </p>
      <ul>
        <li>
          The summary has your classes, scores, weights, units, pass/fail choices, QPA and what SIO shows (grades and
          past semesters). It has no name, Andrew ID, links or syllabus text.
        </li>
        <li>
          {APP_NAME}'s server stores none of it and logs only error codes, never your question or grades. To stop
          abuse, it counts questions per IP address for one minute, in memory only.
        </li>
        <li>
          OpenAI doesn't use it to train its models. It keeps it for up to 30 days to check for abuse (longer only if
          the law requires it). <ExternalLink href={OPENAI_DATA_URL}>OpenAI's policy</ExternalLink>
        </li>
        <li>
          Your chat and the AI advisor's notes are saved only in this browser. You can see, edit or delete the notes in
          Settings, and Clear chat empties the chat.
        </li>
        <li>
          The AI advisor can change your settings (like weights, units or pass/fail) when you ask it to. Each change has
          an Undo.
        </li>
      </ul>

      <h2>What is stored</h2>
      <p>Only in your browser's local storage, under these keys:</p>
      <ul>
        <li>
          <code>{STORE_KEY}</code>: your synced grades, settings and what-ifs, what SIO shows for each semester
          (courses, units, grades and QPA), plus the text of each class's syllabus (at most 60 KB per class) so the
          grading weights stay right between syncs.
        </li>
        <li>
          <code>{THEME_KEY}</code>: light or dark mode, if you picked one.
        </li>
        <li>
          <code>{AUTOLAB_SETTING_KEY}</code>: whether the Chrome extension also syncs Autolab, if you turned it on.
        </li>
        <li>
          <code>{MEMORY_KEY}</code>, <code>{CHAT_KEY}</code> and <code>{CONSENT_KEY}</code>: if you use the AI advisor,
          the notes it saved about you, your last messages with it, and that you accepted its notice.
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
        Open Settings (the gear) and click Delete everything. That also removes the AI advisor's chat and notes.
        Clearing this site's data in your browser does the same.
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
