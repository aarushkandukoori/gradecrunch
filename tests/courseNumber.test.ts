// Tests for finding CMU course numbers in Canvas / Gradescope text.
import { describe, expect, test } from 'vitest'
import { parseCourseNumbers } from '../src/lib/courseNumber'

describe('parseCourseNumbers', () => {
  test.each([
    ['21241', '21241'],
    ['85170-A', '85170'],
    ['99101-DC F25', '99101'],
    ['1. 21241', '21241'],
    ['15-112', '15112'],
    ['21259-1', '21259'],
    ['36202', '36202'],
    ['21-127', '21127'],
    ['36225 Probability Fall 2026', '36225'],
  ])('%s -> %s', (text, number) => {
    expect(parseCourseNumbers(text).number).toBe(number)
  })

  test.each([
    'Career Launch Career Launch - Class of 2029+',
    'Career Launch - Class of 2029+',
    'Placement 25',
    ' CS Assessment Test 2025 - Programming Fundamentals',
    'Fall 2026',
    '120261', // 6-digit run: the 5 digits inside must not match
    '2026-11-12',
    '',
  ])('no number in %j', (text) => {
    expect(parseCourseNumbers(text)).toEqual({ number: null, also: [] })
  })

  test('slash shorthand reuses the department', () => {
    expect(parseCourseNumbers('10-335/615')).toEqual({ number: '10335', also: ['10615'] })
    expect(parseCourseNumbers('10-335/615/618')).toEqual({ number: '10335', also: ['10615', '10618'] })
  })

  test('full cross-listings', () => {
    expect(parseCourseNumbers('15-213/18-213/15-513')).toEqual({ number: '15213', also: ['18213', '15513'] })
  })

  test('first text wins, later texts add distinct cross-listings', () => {
    expect(parseCourseNumbers('21241', '1. 21241', 'Matrices 21241')).toEqual({ number: '21241', also: [] })
    expect(parseCourseNumbers(null, undefined, '15-122 and 15-150')).toEqual({ number: '15122', also: ['15150'] })
    expect(parseCourseNumbers('Nickname', '10601 Intro ML (10-301)')).toEqual({ number: '10601', also: ['10301'] })
  })

  test('no texts at all', () => {
    expect(parseCourseNumbers()).toEqual({ number: null, also: [] })
  })

  test('a number glued to a 4-digit year is not a course', () => {
    expect(parseCourseNumbers('F2026123').number).toBeNull()
  })
})
