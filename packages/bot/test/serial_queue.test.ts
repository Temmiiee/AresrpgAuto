import { describe, expect, it } from 'bun:test'
import { create_serial_queue } from '../src/actions/context.ts'

describe('create_serial_queue', () => {
  it('runs concurrent tasks in FIFO order', async () => {
    const queue = create_serial_queue()
    const order: string[] = []
    const first = queue.run(async () => {
      order.push('first:start')
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push('first:end')
      return 1
    })
    const second = queue.run(async () => { order.push('second'); return 2 })
    const third = queue.run(async () => { order.push('third'); return 3 })
    await expect(Promise.all([first, second, third])).resolves.toEqual([1, 2, 3])
    expect(order).toEqual(['first:start', 'first:end', 'second', 'third'])
  })

  it('releases the queue after a task rejects', async () => {
    const queue = create_serial_queue()
    await expect(queue.run(async () => { throw new Error('expected') })).rejects.toThrow('expected')
    await expect(queue.run(async () => 'recovered')).resolves.toBe('recovered')
  })
})
