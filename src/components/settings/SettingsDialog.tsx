import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  IconDarkOutline16,
  IconDataOutline16,
  IconDownloadOutline16,
  IconFollowsystemOutline16,
  IconLightOutline16,
  IconSettingsOutline16,
  IconThinkOutline16,
  IconUploadOutline14,
} from '../base/icons.js'
import {
  BackupError,
  clearHistory,
  exportHistory,
  importHistory,
  type BackupProgress,
} from '../../services/chat/backup.js'
import {
  DEFAULT_RANGE,
  RangePicker,
  RangeProgress,
  toBackupRange,
  type RangeState,
} from './BackupRange.js'
import { useChatStore } from '../../services/chat/store.js'
import { appVersion, checkForUpdate } from '../../services/updates.js'
import { regionCodes, getRegionName, provinces } from '../../services/location.js'
import {
  INPUT_MODALITIES,
  isChineseBrowser,
  PI_APIS,
  setLocale,
  setProviderConfig,
  setLocation,
  setThemePreference,
  setTtsVoice,
  setUpdateInterval,
  useSettings,
  type InputModality,
  type ThemePreference,
  type UpdateInterval,
} from '../../services/settings.js'
import { builtinProviders, getBuiltinModels, type BuiltinProvider } from '@earendil-works/pi-ai/providers/all'
import { useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { SearchSelect } from '../base/SearchSelect.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import {
  downloadModel,
  getDownloadProgress,
  isLocalAsrSupported,
  isModelReady,
} from '../../services/speech/localAsr.js'
import { closeSettings, useSettingsDialog, type SettingsSection } from './settingsDialogState.js'
import styles from './Settings.module.css'

/**
 * 设置弹窗：分「通用设置」（主题、语言、朗读音色、位置）、「模型配置」（协议、提供商、端点、Key、模型）
 * 与「数据管理」（导入、导出、删除）。桌面端为居中弹窗、左侧导航；移动端为底部弹层、导航横排在内容上方
 */
export const SettingsDialog = () => {
  const open = useSettingsDialog((state) => state.open)
  return open ? <SettingsContent /> : null
}

const sections: { value: SettingsSection; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'general',
    label: 'settingDialogAsideGeneralOptionLabel',
    icon: <IconSettingsOutline16 />,
  },
  { value: 'model', label: 'settingDialogAsideModelOptionLabel', icon: <IconThinkOutline16 /> },
  { value: 'data', label: 'settingDialogAsideDataOptionLabel', icon: <IconDataOutline16 /> },
]

const SettingsContent = () => {
  const t = useTranslate()
  // 打开时按调用方指定的分组选中，之后在弹窗内切换
  const [section, setSection] = useState(() => useSettingsDialog.getState().section)
  const historyImport = useHistoryImport()
  const historyDelete = useHistoryDelete()
  const replacingHistory = useChatStore((state) => state.importingHistory)
  const historyBusy = historyImport.busy || historyDelete.busy || replacingHistory
  return (
    <>
      <Modal
        title={t('settings')}
        closable
        className={styles.dialog}
        mainClassName={styles.dialogMain}
        onClose={() => {
          if (!historyDelete.busy) {
            closeSettings()
          }
        }}
      >
        <div role="tablist" className={styles.navigation}>
          {sections.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={section === item.value}
              className={clsx(styles.navItem, section === item.value && styles.navItemActive)}
              onClick={() => setSection(item.value)}
            >
              {item.icon}
              {t(item.label)}
            </button>
          ))}
        </div>
        <div role="tabpanel" className={styles.content}>
          {section === 'general' ? (
            <>
              <ThemeSetting />
              <LocaleSetting />
              <TtsVoiceSetting />
              <AsrModelSetting />
              <LocationSetting />
              <UpdateSetting />
            </>
          ) : section === 'model' ? (
            <ProviderSetting />
          ) : (
            <>
              <ImportHistory historyImport={historyImport} disabled={historyBusy} />
              <ExportHistory disabled={historyBusy} />
              <SettingCell
                label={t('deleteAllSessions')}
                status={null}
                action={
                  <Button
                    variant="dangerOutlined"
                    size="m"
                    className={styles.cellButton}
                    disabled={historyBusy}
                    onClick={historyDelete.open}
                  >
                    {t('delete')}
                  </Button>
                }
              />
            </>
          )}
        </div>
      </Modal>
      {historyImport.file ? <ImportConfirm historyImport={historyImport} /> : null}
      {historyDelete.opened ? <DeleteAllConfirm historyDelete={historyDelete} /> : null}
    </>
  )
}

/** 删除确认保留在设置之上；失败可重试，成功只关闭确认弹窗。 */
const DeleteAllConfirm = ({
  historyDelete,
}: {
  historyDelete: ReturnType<typeof useHistoryDelete>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('deleteAllSessionsModalTitle')}
      className={styles.deleteConfirm}
      onClose={historyDelete.cancel}
      footer={
        <div className={styles.deleteActions} aria-busy={historyDelete.busy}>
          <Button
            variant="outlined"
            autoFocus
            disabled={historyDelete.busy}
            onClick={historyDelete.cancel}
          >
            {t('cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={historyDelete.busy}
            onClick={() => void historyDelete.confirm()}
          >
            {t(historyDelete.busy ? 'historyDeleting' : 'deleteAllSessions')}
          </Button>
        </div>
      }
    >
      {t('deleteAllSessionsModalDescription')}
    </Modal>
  )
}

const useHistoryDelete = () => {
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const deleting = useRef(false)

  const confirm = async () => {
    if (deleting.current) {
      return
    }
    deleting.current = true
    setBusy(true)
    try {
      await clearHistory()
      setOpened(false)
      showToast({ key: 'historyDeleted' })
    } catch {
      showToast({ key: 'historyDeleteFailed', type: 'error' })
    } finally {
      deleting.current = false
      setBusy(false)
    }
  }

  return {
    opened,
    busy,
    open: () => setOpened(true),
    cancel: () => {
      if (!deleting.current) {
        setOpened(false)
      }
    },
    confirm,
  }
}

const LocationSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const location = useSettings((state) => state.location)
  const province =
    location?.region === 'CN'
      ? provinces.find((item) => item.code === location.province)
      : undefined

  return (
    <SettingCell
      label={t('settingsLocation')}
      status={null}
      className={styles.locationCell}
      action={
        <div className={styles.locationSelectors}>
          {isChineseBrowser() ? (
            <>
              <Select
                ariaLabel={t('settingsLocationProvince')}
                className={styles.provinceSelect}
                value={province?.code ?? ''}
                placeholder={t('settingsLocationProvince')}
                options={provinces.map((item) => ({ value: item.code, label: item.name }))}
                onChange={(value) => {
                  if (value !== province?.code) {
                    setLocation({ region: 'CN', province: value })
                  }
                }}
              />
              <Select
                ariaLabel={t('settingsLocationCity')}
                className={styles.citySelect}
                value={province ? (location?.city ?? '') : ''}
                disabled={!province?.cities.length}
                placeholder={t('settingsLocationCity')}
                options={
                  province?.cities.map((item) => ({ value: item.code, label: item.name })) ?? []
                }
                onChange={(value) => {
                  if (province) {
                    setLocation({ region: 'CN', province: province.code, city: value })
                  }
                }}
              />
            </>
          ) : (
            <Select
              ariaLabel={t('settingsLocationRegion')}
              className={styles.regionSelect}
              value={location?.region ?? ''}
              placeholder={t('settingsLocationRegion')}
              options={regionCodes
                .map((code) => ({ value: code, label: getRegionName(code, locale) }))
                .sort((a, b) => a.label.localeCompare(b.label, locale))}
              onChange={(value) => setLocation({ region: value })}
            />
          )}
        </div>
      }
    />
  )
}

const LocaleSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  return (
    <SettingCell
      label={t('settingsLocalePreference')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsLocalePreference')}
          value={locale}
          options={[
            { value: 'zh-CN', label: t('settingsLocaleZhCN'), lang: 'zh-CN' },
            { value: 'en-US', label: t('settingsLocaleEnUS'), lang: 'en' },
          ]}
          onChange={setLocale}
        />
      }
    />
  )
}

/** token 数压成菜单里的短标签：1M / 384k */
const formatTokens = (value: number): string =>
  value >= 1_000_000
    ? `${Number((value / 1_000_000).toFixed(1))}M`
    : value >= 1000
      ? `${Math.round(value / 1000)}k`
      : String(value)

type CatalogModel = {
  id: string
  name: string
  api: string
  input: InputModality[]
  contextWindow: number
  maxTokens: number
}

/** 读取某个提供商的 models.dev 目录；不在内置目录里时返回空数组 */
const catalogModels = (providerId: string): CatalogModel[] => {
  try {
    return getBuiltinModels(providerId as BuiltinProvider).map((model) => ({
      id: model.id,
      name: model.name,
      api: model.api,
      input: model.input as InputModality[],
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    }))
  } catch {
    return []
  }
}

/** 目录模型使用的协议；不在支持列表里时保持当前协议 */
const supportedApi = (model: CatalogModel | undefined): string | null =>
  model && (PI_APIS as readonly string[]).includes(model.api) ? model.api : null

const MODALITY_LABELS = {
  text: 'modalityText',
  image: 'modalityImage',
  audio: 'modalityAudio',
  video: 'modalityVideo',
} as const satisfies Record<InputModality, TranslationKey>

/**
 * 模型配置：提供商与模型来自内置目录，都可搜索；模型也允许手填目录外的值。
 * 选中目录模型后自动带出协议、上下文、最大输出与输入模态，手改过则保留手改值。
 */
const ProviderSetting = () => {
  const t = useTranslate()
  const provider = useSettings((state) => state.provider)
  const fieldStyle = { marginTop: 8 } as const

  const providers = useMemo(
    () =>
      builtinProviders().map((item) => ({
        value: item.id,
        label: item.name || item.id,
        description: item.name && item.name !== item.id ? item.id : undefined,
      })),
    []
  )
  const models = useMemo(() => catalogModels(provider.piProvider), [provider.piProvider])
  const modelOptions = useMemo(
    () =>
      models.map((model) => ({
        value: model.id,
        label: model.name || model.id,
        description: [
          model.name && model.name !== model.id ? model.id : null,
          `${formatTokens(model.contextWindow)} / ${formatTokens(model.maxTokens)}`,
        ]
          .filter(Boolean)
          .join(' · '),
      })),
    [models]
  )
  const catalogModel = models.find((model) => model.id === provider.model)
  const modalities: InputModality[] =
    provider.inputModalities ??
    (catalogModel?.input.includes('image') ? ['text', 'image'] : ['text'])

  /** 换提供商：优先保留同名模型，否则取目录里的第一个 */
  const selectProvider = (piProvider: string) => {
    const next = catalogModels(piProvider)
    const matched = next.find((model) => model.id === provider.model) ?? next[0]
    const api = supportedApi(matched)
    setProviderConfig({
      piProvider,
      ...(matched ? { model: matched.id } : {}),
      ...(api ? { piApi: api } : {}),
      contextWindow: null,
      maxTokens: null,
      inputModalities: null,
    })
  }

  /** 选目录模型时同步协议，并把容量与模态交回自动匹配 */
  const selectModel = (modelId: string) => {
    const matched = models.find((model) => model.id === modelId)
    const api = supportedApi(matched)
    setProviderConfig({
      model: modelId,
      ...(api ? { piApi: api } : {}),
      contextWindow: null,
      maxTokens: null,
      inputModalities: null,
    })
  }

  const toggleModality = (modality: InputModality) => {
    if (modality === 'text') {
      return
    }
    const next = modalities.includes(modality)
      ? modalities.filter((item) => item !== modality)
      : [...modalities, modality]
    setProviderConfig({
      inputModalities: next.includes('text') ? next : ['text', ...next],
    })
  }

  return (
    <div className={styles.cell}>
      <div className={styles.label}>{t('settingsProviderPiProvider')}</div>
      <div style={{ marginTop: 8 }}>
        <SearchSelect
          ariaLabel={t('settingsProviderPiProvider')}
          value={provider.piProvider}
          options={providers}
          searchPlaceholder={t('settingsProviderSearchProvider')}
          emptyLabel={t('settingsProviderNoMatch')}
          onChange={selectProvider}
        />
      </div>
      <div className={styles.label} style={fieldStyle}>
        {t('settingsProviderModelLabel')}
      </div>
      <div style={{ marginTop: 8 }}>
        <SearchSelect
          ariaLabel={t('settingsProviderModelLabel')}
          value={provider.model}
          options={modelOptions}
          searchPlaceholder={t('settingsProviderSearchModel')}
          emptyLabel={t('settingsProviderNoMatch')}
          freeformLabel={(query) => t('settingsProviderCustomModel', { query })}
          onChange={selectModel}
        />
      </div>
      <div className={styles.apiKeyInput} style={fieldStyle}>
        <input
          type="password"
          placeholder={t('settingsProviderApiKey')}
          autoComplete="new-password"
          spellCheck={false}
          value={provider.apiKey}
          onChange={(event) => setProviderConfig({ apiKey: event.target.value })}
        />
      </div>
      <div className={styles.apiKeyInput} style={fieldStyle}>
        <input
          type="password"
          placeholder={t('settingsProviderServiceApiKey')}
          autoComplete="new-password"
          spellCheck={false}
          value={provider.serviceApiKey}
          onChange={(event) => setProviderConfig({ serviceApiKey: event.target.value })}
        />
      </div>
      <div className={styles.apiKeyInput} style={fieldStyle}>
        <input
          placeholder={t('settingsProviderPiBaseUrl')}
          autoComplete="off"
          spellCheck={false}
          value={provider.piBaseUrl}
          onChange={(event) => setProviderConfig({ piBaseUrl: event.target.value })}
        />
      </div>
      <div className={styles.label} style={fieldStyle}>
        {t('settingsProviderPiApi')}
      </div>
      <div style={{ marginTop: 8 }}>
        <Select
          ariaLabel={t('settingsProviderPiApi')}
          className={styles.fieldSelect}
          value={provider.piApi}
          options={PI_APIS.map((api) => ({ value: api, label: api }))}
          onChange={(piApi) => setProviderConfig({ piApi })}
        />
      </div>
      <div className={styles.label} style={fieldStyle}>
        {t('settingsProviderContextWindow')}
      </div>
      <div className={styles.apiKeyInput} style={{ marginTop: 8 }}>
        <input
          inputMode="numeric"
          placeholder={t('settingsProviderAuto')}
          autoComplete="off"
          spellCheck={false}
          value={provider.contextWindow ?? ''}
          onChange={(event) => {
            const value = Number(event.target.value)
            setProviderConfig({
              contextWindow: Number.isFinite(value) && value > 0 ? Math.trunc(value) : null,
            })
          }}
        />
      </div>
      <div className={styles.label} style={fieldStyle}>
        {t('settingsProviderMaxTokens')}
      </div>
      <div className={styles.apiKeyInput} style={{ marginTop: 8 }}>
        <input
          inputMode="numeric"
          placeholder={t('settingsProviderAuto')}
          autoComplete="off"
          spellCheck={false}
          value={provider.maxTokens ?? ''}
          onChange={(event) => {
            const value = Number(event.target.value)
            setProviderConfig({
              maxTokens: Number.isFinite(value) && value > 0 ? Math.trunc(value) : null,
            })
          }}
        />
      </div>
      <div className={styles.label} style={fieldStyle}>
        {t('settingsProviderModalities')}
      </div>
      <div className={styles.modalities}>
        {INPUT_MODALITIES.map((modality) => (
          <label
            key={modality}
            className={clsx(styles.modality, modality === 'text' && styles.modalityLocked)}
          >
            <input
              type="checkbox"
              checked={modalities.includes(modality)}
              disabled={modality === 'text'}
              onChange={() => toggleModality(modality)}
            />
            {t(MODALITY_LABELS[modality])}
          </label>
        ))}
      </div>
    </div>
  )
}

/** ASR 语音识别模型：默认不自动下载，用户确认许可证提醒后手动下载 */
const AsrModelSetting = () => {
  const t = useTranslate()
  const supported = isLocalAsrSupported()
  const [ready, setReady] = useState<boolean | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [noticeOpen, setNoticeOpen] = useState(false)
  const [percent, setPercent] = useState(0)

  useEffect(() => {
    if (!supported) {
      return
    }
    let cancelled = false
    void isModelReady().then((value) => {
      if (!cancelled) {
        setReady(value)
      }
    })
    return () => {
      cancelled = true
    }
  }, [supported])

  if (!supported) {
    return null
  }

  const download = async () => {
    if (downloading) {
      return
    }
    setNoticeOpen(false)
    setDownloading(true)
    setPercent(0)
    const timer = setInterval(() => {
      void getDownloadProgress().then((progress) => {
        if (progress.total > 0) {
          setPercent(Math.min(100, Math.round((progress.downloaded / progress.total) * 100)))
        }
      })
    }, 400)
    try {
      await downloadModel()
      setReady(true)
      showToast({ key: 'asrModelDownloaded' })
    } catch {
      showToast({ key: 'asrModelDownloadFailed', type: 'error' })
    } finally {
      clearInterval(timer)
      setDownloading(false)
    }
  }

  const description = downloading
    ? t('asrModelDownloadingPercent', { percent })
    : ready === null
      ? ''
      : t(ready ? 'asrModelReady' : 'asrModelNotDownloaded')

  return (
    <>
      <SettingCell
        label={t('settingsAsrModel')}
        description={description}
        status={null}
        action={
          <Button
            variant="outlined"
            size="m"
            className={styles.cellButton}
            disabled={downloading || ready === true}
            onClick={() => setNoticeOpen(true)}
          >
            {t(downloading ? 'asrModelDownloading' : 'asrModelDownload')}
          </Button>
        }
      />
      {downloading ? (
        <div
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          style={{
            height: 4,
            marginBlock: 8,
            borderRadius: 2,
            background: 'var(--dsw-alias-bg-skeleton)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              height: '100%',
              width: `${percent}%`,
              borderRadius: 2,
              background: 'var(--dsw-alias-brand-primary)',
              transition: 'width 200ms ease',
            }}
          />
        </div>
      ) : null}
      {noticeOpen ? (
        <Modal
          title={t('asrModelNoticeTitle')}
          className={styles.deleteConfirm}
          onClose={() => setNoticeOpen(false)}
          footer={
            <div className={styles.deleteActions}>
              <Button variant="outlined" autoFocus onClick={() => setNoticeOpen(false)}>
                {t('asrModelNoticeCancel')}
              </Button>
              <Button variant="primary" onClick={() => void download()}>
                {t('asrModelNoticeConfirm')}
              </Button>
            </div>
          }
        >
          {t('asrModelNoticeBody')}
        </Modal>
      ) : null}
    </>
  )
}

const TtsVoiceSetting = () => {
  const t = useTranslate()
  const ttsVoice = useSettings((state) => state.ttsVoice)
  return (
    <SettingCell
      label={t('settingsTtsVoice')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsTtsVoice')}
          value={ttsVoice}
          options={[
            { value: 'stella', label: t('settingsTtsVoiceStella') },
            { value: 'tide', label: t('settingsTtsVoiceTide') },
          ]}
          onChange={setTtsVoice}
        />
      }
    />
  )
}

/** 覆盖导入的二次确认，叠在设置弹窗上 */
const ImportConfirm = ({
  historyImport,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('historyImportConfirmTitle')}
      className={styles.importConfirm}
      onClose={historyImport.cancel}
      footer={
        <>
          <Button
            variant="outlined"
            size="m"
            autoFocus
            disabled={historyImport.busy}
            onClick={historyImport.cancel}
          >
            {t('cancel')}
          </Button>
          <Button
            variant="dangerOutlined"
            size="m"
            disabled={historyImport.busy}
            onClick={() => void historyImport.confirm()}
          >
            {t(historyImport.busy ? 'historyImporting' : 'historyImportConfirm')}
          </Button>
        </>
      }
    >
      <div className={styles.importConfirmText}>{t('historyImportConfirmDescription')}</div>
      <div className={styles.label} style={{ marginTop: 16 }}>
        {t('historyRangeLabel')}
      </div>
      <RangePicker
        value={historyImport.range}
        onChange={historyImport.setRange}
        disabled={historyImport.busy}
      />
      <RangeProgress progress={historyImport.progress} />
    </Modal>
  )
}

const themeOptions: { value: ThemePreference; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'light',
    label: 'avatarMenuSettingsDialogThemeSelectLightOption',
    icon: <IconLightOutline16 />,
  },
  {
    value: 'dark',
    label: 'avatarMenuSettingsDialogThemeSelectDarkOption',
    icon: <IconDarkOutline16 />,
  },
  {
    value: 'system',
    label: 'avatarMenuSettingsDialogThemeSelectSystemOption',
    icon: <IconFollowsystemOutline16 />,
  },
]

/**
 * 主题项：标题下方浅色 / 深色 / 跟随系统三个选块。
 * 与下方语言选项连续排列。
 */
const ThemeSetting = () => {
  const t = useTranslate()
  const themePreference = useSettings((state) => state.themePreference)
  const label = t('avatarMenuSettingsDialogThemeItemLabel')
  return (
    <div className={styles.theme}>
      {label}
      <div role="radiogroup" aria-label={label} className={styles.themeOptions}>
        {themeOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={themePreference === option.value}
            className={clsx(
              styles.themeOption,
              themePreference === option.value && styles.themeOptionSelected
            )}
            onClick={() => setThemePreference(option.value)}
          >
            {option.icon}
            {t(option.label)}
          </button>
        ))}
      </div>
    </div>
  )
}

/** `reason` 为失败原因的文案 key，展示时按当前语言翻译后填入 `message` 参数。 */
type Status = (TranslationMessage & { error?: boolean; reason?: TranslationKey }) | null

/** 导出失败附带原因：预期的错误用对应文案作原因，其他错误用错误信息。 */
const errorStatus = (key: TranslationKey, error: unknown): Status => ({
  key,
  ...(error instanceof BackupError
    ? { reason: error.key }
    : { params: { message: error instanceof Error ? error.message : String(error) } }),
  error: true,
})

const SettingCell = ({
  label,
  description,
  status,
  action,
  className,
}: {
  label: string
  description?: string
  status: Status
  action: ReactNode
  className?: string
}) => {
  const t = useTranslate()
  return (
    <div className={clsx(styles.cell, styles.row, className)}>
      <div className={styles.text}>
        <div className={styles.label}>{label}</div>
        {status || description ? (
          <div className={clsx(styles.description, status?.error && styles.error)}>
            {status
              ? t(status.key, status.reason ? { message: t(status.reason) } : status.params)
              : description}
          </div>
        ) : null}
      </div>
      {action}
    </div>
  )
}

/** 更新间隔的选项值用字符串，Select 统一按 string 处理 */
const parseUpdateInterval = (value: string): UpdateInterval =>
  value === 'never' ? 'never' : value === '7' ? 7 : value === '30' ? 30 : 1

/** 检查更新：显示当前版本与立即检查入口，下方可设置自动检查间隔 */
const UpdateSetting = () => {
  const t = useTranslate()
  const updateInterval = useSettings((state) => state.updateInterval)
  const [busy, setBusy] = useState(false)
  const [update, setUpdate] = useState<{ version: string; url: string } | null>(null)
  const [status, setStatus] = useState<Status>(null)

  const check = async () => {
    setBusy(true)
    setStatus(null)
    const result = await checkForUpdate(true)
    setBusy(false)
    if (result.state === 'update') {
      setUpdate({ version: result.version, url: result.url })
      setStatus(null)
      return
    }
    setUpdate(null)
    setStatus({ key: result.state === 'latest' ? 'settingsUpdateLatest' : 'settingsUpdateFailed' })
  }

  return (
    <>
      <SettingCell
        label={t('settingsUpdate')}
        description={t('settingsUpdateDescription', { version: appVersion() })}
        status={
          busy
            ? { key: 'settingsUpdateChecking' }
            : update
              ? { key: 'settingsUpdateAvailable', params: { version: update.version } }
              : status
        }
        action={
          update ? (
            <Button
              variant="primary"
              size="m"
              className={styles.cellButton}
              onClick={() => window.open(update.url, '_blank', 'noreferrer')}
            >
              {t('settingsUpdateDownload')}
            </Button>
          ) : (
            <Button
              variant="outlined"
              size="m"
              className={styles.cellButton}
              disabled={busy}
              onClick={() => void check()}
            >
              {t('settingsUpdateCheckNow')}
            </Button>
          )
        }
      />
      <SettingCell
        label={t('settingsUpdateAutoCheck')}
        description={t('settingsUpdateAutoCheckDescription')}
        status={null}
        action={
          <Select
            ariaLabel={t('settingsUpdateAutoCheck')}
            value={String(updateInterval)}
            options={[
              { value: '1', label: t('settingsUpdateIntervalDaily') },
              { value: '7', label: t('settingsUpdateIntervalWeekly') },
              { value: '30', label: t('settingsUpdateIntervalMonthly') },
              { value: 'never', label: t('settingsUpdateIntervalNever') },
            ]}
            onChange={(value) => setUpdateInterval(parseUpdateInterval(value))}
          />
        }
      />
    </>
  )
}

/** 选文件后先提示覆盖；确认后才检查文件并执行导入，任何错误都提示导入失败。 */
const useHistoryImport = () => {
  const [file, setFile] = useState<File | null>(null)
  const [range, setRange] = useState<RangeState>(DEFAULT_RANGE)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<BackupProgress | null>(null)
  const [status, setStatus] = useState<Status>(null)
  const importing = useRef(false)

  const select = (next: File) => {
    setFile(next)
    setRange(DEFAULT_RANGE)
    setStatus(null)
    setProgress(null)
  }

  const confirm = async () => {
    if (!file || importing.current) {
      return
    }
    importing.current = true
    setBusy(true)
    setStatus(null)
    setProgress(null)
    try {
      const count = await importHistory(file, {
        range: toBackupRange(range),
        onProgress: setProgress,
      })
      setStatus({ key: count === 1 ? 'historyImportedOne' : 'historyImported', params: { count } })
    } catch (error) {
      setStatus(errorStatus('historyImportFailed', error))
    } finally {
      importing.current = false
      setBusy(false)
      setProgress(null)
      // 结束后再关弹窗，进度条在导入期间保持可见
      setFile(null)
    }
  }

  return {
    file,
    range,
    setRange,
    busy,
    progress,
    status,
    select,
    cancel: () => {
      if (!importing.current) {
        setFile(null)
        setProgress(null)
      }
    },
    confirm,
  }
}

/** 导入 = 覆盖：用选中文件替换本地全部会话与附件。 */
const ImportHistory = ({
  historyImport,
  disabled,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
  disabled: boolean
}) => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <SettingCell
      label={t('historyImport')}
      description={t('historyImportDescription')}
      status={historyImport.status}
      action={
        <>
          <Button
            variant="outlined"
            size="m"
            className={clsx(styles.cellButton, styles.uploadButton)}
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            <IconUploadOutline14 />
            {t('upload')}
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) {
                historyImport.select(file)
              }
            }}
          />
        </>
      }
    />
  )
}

/** 按范围把会话及图片导出为 ZIP 并下载 */
const ExportHistory = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const empty = useChatStore((state) => state.sessions.length === 0)
  const [opened, setOpened] = useState(false)
  const [range, setRange] = useState<RangeState>(DEFAULT_RANGE)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<BackupProgress | null>(null)
  const [status, setStatus] = useState<Status>(null)

  const close = () => {
    if (!busy) {
      setOpened(false)
    }
  }

  const onExport = async () => {
    setBusy(true)
    setProgress(null)
    setStatus(null)
    try {
      const { name, blob } = await exportHistory({
        range: toBackupRange(range),
        onProgress: setProgress,
      })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      setOpened(false)
      showToast({ key: 'historyExported' })
    } catch (error) {
      setStatus(errorStatus('historyExportFailed', error))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  return (
    <>
      <SettingCell
        label={t('exportAllLabel')}
        description={t('historyExportDescription')}
        status={status}
        action={
          <Button
            variant="outlined"
            size="m"
            className={styles.cellButton}
            disabled={disabled || empty}
            onClick={() => {
              setStatus(null)
              setOpened(true)
            }}
          >
            <IconDownloadOutline16 />
            {t('exportAllDownload')}
          </Button>
        }
      />
      {opened ? (
        <Modal
          title={t('historyExportRangeTitle')}
          className={styles.importConfirm}
          onClose={close}
          footer={
            <>
              <Button variant="outlined" size="m" autoFocus disabled={busy} onClick={close}>
                {t('cancel')}
              </Button>
              <Button variant="primary" size="m" disabled={busy} onClick={() => void onExport()}>
                {t(busy ? 'historyExporting' : 'historyExportConfirm')}
              </Button>
            </>
          }
        >
          <div className={styles.importConfirmText}>{t('historyExportRangeDescription')}</div>
          <div className={styles.label} style={{ marginTop: 16 }}>
            {t('historyRangeLabel')}
          </div>
          <RangePicker value={range} onChange={setRange} disabled={busy} />
          <RangeProgress progress={progress} />
        </Modal>
      ) : null}
    </>
  )
}
