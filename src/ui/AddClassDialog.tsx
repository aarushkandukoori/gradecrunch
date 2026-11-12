// "Add a class by hand" in a small dialog, for classes not on Canvas or Gradescope.
import type { ManualCourse } from '../types'
import { ManualCourseForm } from './ManualCourseForm'
import { Modal } from './Modal'

interface Props {
  open: boolean
  onClose: () => void
  term: string | null
  onAdd: (course: ManualCourse) => void
}

export function AddClassDialog({ open, onClose, term, onAdd }: Props) {
  return (
    <Modal open={open} onClose={onClose} title="Add a class by hand">
      <p className="muted small">For a class that isn't on Canvas or Gradescope.</p>
      <ManualCourseForm
        term={term}
        onAdd={(course) => {
          onAdd(course)
          onClose()
        }}
      />
    </Modal>
  )
}
