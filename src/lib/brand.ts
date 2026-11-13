// Product name and links in one place, so renaming the app is a one-line change.
export const APP_NAME = 'GradeCrunch'
export const APP_SLUG = 'gradecrunch' // localStorage key prefix and Cloudflare Pages project name
export const SITE_URL = 'https://grades.aarushkandukoori.com' // the main address
// The original Cloudflare address. It still works, but sends visitors to SITE_URL so everyone's grades live in one
// place (browsers keep saved data per address).
export const OLD_SITE_HOST = 'gradecrunch.pages.dev'
export const REPO_URL = 'https://github.com/aarushkandukoori/gradecrunch'
export const CANVAS_ORIGIN = 'https://canvas.cmu.edu'
export const GRADESCOPE_ORIGIN = 'https://www.gradescope.com'
export const AUTOLAB_ORIGIN = 'https://autolab.andrew.cmu.edu'
export const SIO_ORIGIN = 'https://s3.andrew.cmu.edu' // SIO, CMU's official record (Student Information Online)
export const SIO_GRADES_URL = `${SIO_ORIGIN}/sio/mpa/grades/home` // the "Grades and QPA" page
// The Chrome Web Store page of the GradeCrunch extension. Empty until it is published: while empty, the welcome
// page keeps the Sync bookmarklet as the main way in and only says the extension is coming soon.
export const CHROME_STORE_URL: string = ''
