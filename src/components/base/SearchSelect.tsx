import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss } from './anchored.js'
import { IconCheckOutline16, IconChevronDownOutline14 } from './icons.js'
import styles from './SearchSelect.module.css'

export type SearchSelectOption = {
  value: string
  label: string
  /** 行内的次要说明，例如模型 id 与容量 */
  description?: string
}

type Row = SearchSelectOption & { custom?: boolean }

/**
 * 可搜索的下拉选择：触发器和输入框同宽，菜单挂在 body 上避免被弹窗裁切。
 * 选项较多时（提供商、模型目录）在菜单顶部提供搜索框，支持上下键与回车选择；
 * 传入 freeformLabel 时，列表外的输入会作为自定义值提交。
 */
export const SearchSelect = ({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder,
  searchPlaceholder,
  emptyLabel,
  freeformLabel,
  className,
  disabled = false,
}: {
  value: string
  options: SearchSelectOption[]
  onChange: (value: string) => void
  ariaLabel: string
  placeholder?: string
  searchPlaceholder: string
  emptyLabel: string
  /** 允许列表外的值；返回该自定义行的文案 */
  freeformLabel?: (query: string) => string
  className?: string
  disabled?: boolean
}) => {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const { anchorRef, floatingRef, position } = useAnchoredPosition<
    HTMLButtonElement,
    HTMLDivElement
  >(open, { align: 'start', offset: 6, maxHeight: 320, minSpace: 180 })
  // Esc 只关下拉，不让外层设置弹窗一起关闭
  useDismiss(open, [anchorRef, floatingRef], () => setOpen(false), { captureEscape: true })

  const current = options.find((option) => option.value === value)
  const rows = useMemo<Row[]>(() => {
    const keyword = query.trim().toLowerCase()
    const matched = keyword
      ? options.filter((option) =>
          `${option.label} ${option.value}`.toLowerCase().includes(keyword)
        )
      : options
    const customValue = query.trim()
    const canUseCustom =
      freeformLabel !== undefined &&
      customValue.length > 0 &&
      !options.some((option) => option.value === customValue)
    return canUseCustom
      ? [...matched, { value: customValue, label: freeformLabel(customValue), custom: true }]
      : matched
  }, [freeformLabel, options, query])

  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIndex(0)
    }
  }, [open])

  useEffect(() => {
    if (open) {
      inputRef.current?.focus()
    }
  }, [open])

  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(rows.length - 1, 0)))
  }, [rows.length])

  const choose = (next: string) => {
    setOpen(false)
    if (next !== value) {
      onChange(next)
    }
  }

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => Math.min(index + 1, Math.max(rows.length - 1, 0)))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => Math.max(index - 1, 0))
      return
    }
    if (event.key === 'Enter') {
      const row = rows[activeIndex]
      if (row) {
        event.preventDefault()
        choose(row.value)
      }
    }
  }

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={clsx(styles.trigger, className)}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        {current ? (
          <span className={styles.value}>{current.label}</span>
        ) : (
          <span className={clsx(styles.value, styles.placeholder)}>
            {value || placeholder}
          </span>
        )}
        <span className={styles.arrow}>
          <IconChevronDownOutline14 />
        </span>
      </button>
      {open && !disabled
        ? createPortal(
            <div ref={floatingRef} className={styles.menu} style={position ?? undefined}>
              <input
                ref={inputRef}
                className={styles.search}
                value={query}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setActiveIndex(0)
                }}
                onKeyDown={onSearchKeyDown}
              />
              <div className={styles.list} role="listbox" aria-label={ariaLabel}>
                {rows.length === 0 ? (
                  <div className={styles.empty}>{emptyLabel}</div>
                ) : (
                  rows.map((row, index) => (
                    <button
                      key={row.custom ? `custom:${row.value}` : row.value}
                      type="button"
                      role="option"
                      aria-selected={row.value === value}
                      className={clsx(
                        styles.option,
                        index === activeIndex && styles.optionActive
                      )}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => choose(row.value)}
                    >
                      <span className={styles.optionText}>
                        <span className={styles.optionLabel}>{row.label}</span>
                        {row.description ? (
                          <span className={styles.optionDescription}>{row.description}</span>
                        ) : null}
                      </span>
                      {row.value === value ? <IconCheckOutline16 /> : null}
                    </button>
                  ))
                )}
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  )
}
