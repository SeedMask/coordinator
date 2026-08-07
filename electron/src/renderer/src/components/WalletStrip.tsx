import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { WalletDTO } from '@renderer/api/types'
import { DraftWalletStripChip, WalletStripChipView } from '@renderer/components/WalletStripChip'
import { UserPrefs } from '@renderer/utils/userPrefs'

const DRAG_THRESHOLD_PX = 6
const SELECT_DELAY_MS = 220
const AUTO_SCROLL_EDGE_PX = 56
const AUTO_SCROLL_MAX_PX = 18
const STRIP_GAP_PX = 8
const STRIP_PAD_X = 16
const FLIP_MS = 180

type FrozenStripProps = {
  walletBalances: Record<string, string>
  activeWalletId: string | undefined
  isAddingWallet: boolean
}

function orderWithInsert(ids: string[], dragId: string, insertAt: number): string[] {
  const without = ids.filter((id) => id !== dragId)
  const clamped = Math.max(0, Math.min(insertAt, without.length))
  return [...without.slice(0, clamped), dragId, ...without.slice(clamped)]
}

/** Stable insert index from drag-start widths (not live DOM), so live reorder cannot oscillate. */
function insertIndexFromProjection(
  clientX: number,
  strip: HTMLElement,
  dragId: string,
  widths: Record<string, number>,
  baseOrder: string[],
): number {
  const contentX = clientX - strip.getBoundingClientRect().left + strip.scrollLeft
  const without = baseOrder.filter((id) => id !== dragId)
  let x = STRIP_PAD_X
  for (let i = 0; i < without.length; i++) {
    const w = widths[without[i]] ?? 0
    const mid = x + w / 2
    if (contentX < mid) return i
    x += w + STRIP_GAP_PX
  }
  return without.length
}

function measureSlotLefts(strip: HTMLElement, ids: string[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const id of ids) {
    const el = strip.querySelector<HTMLElement>(`[data-wallet-id="${id}"]`)
    if (el) map.set(id, el.getBoundingClientRect().left)
  }
  return map
}

function playFlip(strip: HTMLElement, first: Map<string, number>, ids: string[]): void {
  for (const id of ids) {
    const el = strip.querySelector<HTMLElement>(`[data-wallet-id="${id}"]`)
    const from = first.get(id)
    if (!el || from == null) continue
    const to = el.getBoundingClientRect().left
    const dx = from - to
    if (Math.abs(dx) < 0.5) continue
    el.style.transition = 'none'
    el.style.transform = `translateX(${dx}px)`
    // Force reflow so the invert sticks before playing.
    void el.offsetWidth
    el.style.transition = `transform ${FLIP_MS}ms cubic-bezier(0.2, 0, 0, 1)`
    el.style.transform = ''
  }
}

export function WalletStrip({
  wallets,
  orderIds,
  activeWalletId,
  isAddingWallet,
  walletBalances,
  isRefreshing,
  onSelect,
  onRename,
  onDelete,
  onLock,
  onUnlock,
  onChangePassword,
  onEncrypt,
  onReorder,
  onAdd,
  onSelectDraft,
  onRemoveDraft,
  isAddingWalletActive,
  showDraftWallet,
  draftWalletLabel,
  chipPresentation,
}: {
  wallets: WalletDTO[]
  orderIds: string[]
  activeWalletId: string | undefined
  isAddingWallet: boolean
  walletBalances: Record<string, string>
  isRefreshing: (id: string) => boolean
  onSelect: (id: string) => void
  onRename: (id: string) => void
  onDelete: (id: string) => void
  onLock?: (id: string) => void
  onUnlock?: (id: string) => void
  onChangePassword?: (id: string) => void
  onEncrypt?: (id: string) => void
  onReorder: (ids: string[]) => void
  onAdd: () => void
  onSelectDraft?: () => void
  onRemoveDraft?: () => void
  isAddingWalletActive: boolean
  showDraftWallet?: boolean
  draftWalletLabel?: string
  chipPresentation?: Record<
    string,
    {
      selected: boolean
      displayLabel: string
      accountIndex?: number
      balanceWalletId: string
      scanningWalletId: string
    }
  >
}): React.JSX.Element {
  const stripRef = useRef<HTMLDivElement>(null)
  const ghostRef = useRef<HTMLDivElement>(null)
  const orderRef = useRef(orderIds)
  const pendingRef = useRef<{ id: string; x: number; y: number } | null>(null)
  const dragIdRef = useRef<string | null>(null)
  const widthsRef = useRef<Record<string, number>>({})
  const insertRef = useRef(0)
  const ghostOffsetRef = useRef({ x: 0, y: 0 })
  const ghostSizeRef = useRef({ w: 0, h: 0 })
  const draggedRef = useRef(false)
  const rafRef = useRef<number | null>(null)
  const pointerRef = useRef({ x: 0, y: 0 })
  const frozenRef = useRef<FrozenStripProps | null>(null)
  const selectTimerRef = useRef<number | null>(null)
  const flipFromRef = useRef<Map<string, number> | null>(null)
  const previewOrderRef = useRef<string[] | null>(null)

  const [isDragging, setIsDragging] = useState(false)
  const [dragId, setDragId] = useState<string | null>(null)
  const [previewOrder, setPreviewOrder] = useState<string[] | null>(null)
  const [hiddenBalanceIds, setHiddenBalanceIds] = useState<Set<string>>(
    () => new Set(UserPrefs.walletStripHiddenBalanceIds),
  )

  orderRef.current = orderIds
  previewOrderRef.current = previewOrder

  const displayOrder = previewOrder ?? orderIds
  const byId = useMemo(() => new Map(wallets.map((w) => [w.id, w])), [wallets])
  const displayBalances = isDragging && frozenRef.current ? frozenRef.current.walletBalances : walletBalances
  const displayActiveId = isDragging && frozenRef.current ? frozenRef.current.activeWalletId : activeWalletId
  const displayAdding = isDragging && frozenRef.current ? frozenRef.current.isAddingWallet : isAddingWallet

  function clearSelectTimer(): void {
    if (selectTimerRef.current != null) {
      window.clearTimeout(selectTimerRef.current)
      selectTimerRef.current = null
    }
  }

  function suppressSelect(): void {
    clearSelectTimer()
  }

  function toggleBalanceVisibility(walletId: string): void {
    setHiddenBalanceIds((current) => {
      const next = new Set(current)
      if (next.has(walletId)) next.delete(walletId)
      else next.add(walletId)
      UserPrefs.walletStripHiddenBalanceIds = Array.from(next)
      return next
    })
  }

  useEffect(() => () => clearSelectTimer(), [])

  useLayoutEffect(() => {
    const strip = stripRef.current
    const first = flipFromRef.current
    if (!strip || !first || !dragId) return
    flipFromRef.current = null
    playFlip(strip, first, displayOrder)
  }, [displayOrder, dragId])

  useEffect(() => {
    const clearDragUi = (): void => {
      const strip = stripRef.current
      const ghost = ghostRef.current
      if (strip) {
        strip.classList.remove('dragging')
        for (const slot of Array.from(strip.querySelectorAll<HTMLElement>('.wallet-strip-slot'))) {
          slot.style.transition = ''
          slot.style.transform = ''
        }
      }
      if (ghost) {
        ghost.style.opacity = '0'
        ghost.style.transform = ''
        ghost.replaceChildren()
      }
      frozenRef.current = null
      dragIdRef.current = null
      widthsRef.current = {}
      flipFromRef.current = null
      setDragId(null)
      setPreviewOrder(null)
      setIsDragging(false)
    }

    const placeGhost = (clientX: number): void => {
      const ghost = ghostRef.current
      const strip = stripRef.current
      if (!ghost || !strip) return
      const stripRect = strip.getBoundingClientRect()
      const { h } = ghostSizeRef.current
      const y = stripRect.top + (stripRect.height - h) / 2
      const x = clientX - ghostOffsetRef.current.x
      ghost.style.transform = `translate3d(${x}px, ${y}px, 0)`
    }

    const autoScroll = (clientX: number): boolean => {
      const strip = stripRef.current
      if (!strip) return false
      const rect = strip.getBoundingClientRect()
      let scrolled = false
      if (clientX > rect.right - AUTO_SCROLL_EDGE_PX) {
        const t = Math.min(1, (clientX - (rect.right - AUTO_SCROLL_EDGE_PX)) / AUTO_SCROLL_EDGE_PX)
        const before = strip.scrollLeft
        strip.scrollLeft += Math.ceil(AUTO_SCROLL_MAX_PX * t * t)
        scrolled = strip.scrollLeft !== before
      } else if (clientX < rect.left + AUTO_SCROLL_EDGE_PX) {
        const t = Math.min(1, (rect.left + AUTO_SCROLL_EDGE_PX - clientX) / AUTO_SCROLL_EDGE_PX)
        const before = strip.scrollLeft
        strip.scrollLeft -= Math.ceil(AUTO_SCROLL_MAX_PX * t * t)
        scrolled = strip.scrollLeft !== before
      }
      return scrolled
    }

    const applyInsert = (insertAt: number): void => {
      const currentDrag = dragIdRef.current
      const strip = stripRef.current
      if (!currentDrag || !strip) return
      const next = orderWithInsert(orderRef.current, currentDrag, insertAt)
      const prev = previewOrderRef.current
      if (prev && prev.join('|') === next.join('|')) return
      insertRef.current = insertAt
      flipFromRef.current = measureSlotLefts(strip, prev ?? orderRef.current)
      setPreviewOrder(next)
    }

    const paint = (): void => {
      rafRef.current = null
      const strip = stripRef.current
      const currentDrag = dragIdRef.current
      if (!strip || !currentDrag) return

      const { x } = pointerRef.current
      const scrolled = autoScroll(x)
      placeGhost(x)

      const insertAt = insertIndexFromProjection(
        x,
        strip,
        currentDrag,
        widthsRef.current,
        orderRef.current,
      )
      applyInsert(insertAt)

      // Keep scrolling while held near an edge.
      if (scrolled) schedulePaint()
    }

    const schedulePaint = (): void => {
      if (rafRef.current != null) return
      rafRef.current = window.requestAnimationFrame(paint)
    }

    const startDrag = (id: string, clientX: number, clientY: number): void => {
      const strip = stripRef.current
      const ghost = ghostRef.current
      if (!strip || !ghost) return

      clearSelectTimer()
      draggedRef.current = true
      dragIdRef.current = id
      pendingRef.current = null
      frozenRef.current = {
        walletBalances,
        activeWalletId,
        isAddingWallet,
      }

      const widths: Record<string, number> = {}
      for (const wid of orderRef.current) {
        const slot = strip.querySelector<HTMLElement>(`[data-wallet-id="${wid}"]`)
        const chip = slot?.querySelector<HTMLElement>('.wallet-strip-chip')
        const rect = (chip ?? slot)?.getBoundingClientRect()
        if (rect) widths[wid] = rect.width
      }
      widthsRef.current = widths

      const slot = strip.querySelector<HTMLElement>(`[data-wallet-id="${id}"]`)
      const chip = slot?.querySelector<HTMLElement>('.wallet-strip-chip')
      const rect = (chip ?? slot)?.getBoundingClientRect()
      if (!rect) return

      ghostOffsetRef.current = { x: clientX - rect.left, y: clientY - rect.top }
      ghostSizeRef.current = { w: rect.width, h: rect.height }
      ghost.style.width = `${rect.width}px`
      ghost.style.height = `${rect.height}px`
      if (chip) ghost.replaceChildren(chip.cloneNode(true))
      ghost.style.opacity = '1'
      placeGhost(clientX)

      const insertAt = insertIndexFromProjection(clientX, strip, id, widths, orderRef.current)
      insertRef.current = insertAt

      strip.classList.add('dragging')
      setIsDragging(true)
      setDragId(id)
      setPreviewOrder(orderWithInsert(orderRef.current, id, insertAt))
    }

    const onMove = (e: PointerEvent): void => {
      pointerRef.current = { x: e.clientX, y: e.clientY }
      const pending = pendingRef.current

      if (pending && !dragIdRef.current) {
        const dx = e.clientX - pending.x
        const dy = e.clientY - pending.y
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
        startDrag(pending.id, e.clientX, e.clientY)
        return
      }

      if (!dragIdRef.current) return
      schedulePaint()
    }

    const onUp = (): void => {
      const pending = pendingRef.current
      pendingRef.current = null
      if (rafRef.current != null) {
        window.cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }

      if (dragIdRef.current) {
        const finalOrder = previewOrderRef.current ?? orderRef.current
        const base = orderRef.current
        clearDragUi()
        if (finalOrder.join('|') !== base.join('|')) onReorder(finalOrder)
        window.setTimeout(() => {
          draggedRef.current = false
        }, 0)
        return
      }

      if (pending && !draggedRef.current) {
        clearSelectTimer()
        const id = pending.id
        selectTimerRef.current = window.setTimeout(() => {
          selectTimerRef.current = null
          onSelect(id)
        }, SELECT_DELAY_MS)
      }
      draggedRef.current = false
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      if (rafRef.current != null) window.cancelAnimationFrame(rafRef.current)
    }
  }, [onReorder, onSelect, walletBalances, activeWalletId, isAddingWallet])

  return (
    <div className="wallet-strip" ref={stripRef}>
      {displayOrder.map((id) => {
        const wallet = byId.get(id)
        if (!wallet) return null
        const isDropSlot = dragId === id
        const width = widthsRef.current[id]
        const pres = chipPresentation?.[id]
        const selected = !displayAdding && (pres ? pres.selected : id === displayActiveId)
        const balanceId = pres?.balanceWalletId ?? id
        const scanId = pres?.scanningWalletId ?? id
        const balanceHidden = hiddenBalanceIds.has(id)

        if (isDropSlot) {
          return (
            <div
              key={id}
              className="wallet-strip-slot wallet-strip-drop-slot"
              data-wallet-id={id}
              style={width ? { width, minWidth: width } : undefined}
              aria-hidden
            />
          )
        }

        return (
          <div key={id} className="wallet-strip-slot" data-wallet-id={id}>
            <WalletStripChipView
              wallet={wallet}
              selected={selected}
              scanning={!isDragging && isRefreshing(scanId)}
              balance={balanceHidden ? undefined : displayBalances[balanceId]}
              displayLabel={pres?.displayLabel}
              accountIndex={pres?.accountIndex}
              balanceHidden={balanceHidden}
              onRename={() => onRename(id)}
              onToggleBalance={() => toggleBalanceVisibility(id)}
              onLock={onLock && wallet.encrypted ? () => onLock(id) : undefined}
              onUnlock={onUnlock && wallet.encrypted && !wallet.unlocked ? () => onUnlock(id) : undefined}
              onChangePassword={
                onChangePassword && wallet.encrypted ? () => onChangePassword(id) : undefined
              }
              onEncrypt={onEncrypt && !wallet.encrypted ? () => onEncrypt(id) : undefined}
              onDelete={() => onDelete(id)}
              onSuppressSelect={suppressSelect}
              onPointerDown={(e) => {
                if (e.button !== 0) return
                pendingRef.current = { id, x: e.clientX, y: e.clientY }
                draggedRef.current = false
              }}
            />
          </div>
        )
      })}
      {showDraftWallet && (
        <div className="wallet-strip-slot wallet-strip-slot-draft">
          <DraftWalletStripChip
            label={draftWalletLabel ?? ''}
            selected={isAddingWalletActive}
            onSelect={() => (onSelectDraft ?? onAdd)()}
            onRemove={() => onRemoveDraft?.()}
          />
        </div>
      )}
      <button
        type="button"
        className={`wallet-strip-add${isAddingWalletActive && !showDraftWallet ? ' active' : ''}`}
        title="Add watch-only wallet"
        onClick={onAdd}
      >
        +
      </button>

      <div ref={ghostRef} className="wallet-strip-ghost" style={{ opacity: 0 }} />
    </div>
  )
}
