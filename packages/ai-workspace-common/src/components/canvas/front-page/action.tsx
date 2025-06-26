import { Button, Tooltip, Switch, Segmented } from 'antd';
import { memo, useMemo, useRef, useCallback } from 'react';
import { LinkOutlined, SendOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useUserStoreShallow } from '@refly-packages/ai-workspace-common/stores/user';
import { getRuntime } from '@refly/utils/env';
import { ModelSelector } from '@refly-packages/ai-workspace-common/components/canvas/launchpad/chat-actions/model-selector';
import { ModelInfo } from '@refly/openapi-schema';
import { cn, extractUrlsWithLinkify } from '@refly/utils/index';
import { SkillRuntimeConfig } from '@refly/openapi-schema';
import { IconAskAI, IconPilot } from '@refly-packages/ai-workspace-common/components/common/icon';
import { useChatStoreShallow } from '@refly-packages/ai-workspace-common/stores/chat';

export interface CustomAction {
  content?: string;
  icon: React.ReactNode;
  title: string;
  onClick: () => void;
}

interface ActionsProps {
  query: string;
  model: ModelInfo | null;
  setModel: (model: ModelInfo | null) => void;
  runtimeConfig: SkillRuntimeConfig;
  setRuntimeConfig: (runtimeConfig: SkillRuntimeConfig) => void;
  className?: string;
  handleSendMessage: () => void;
  handleAbort: () => void;
  customActions?: CustomAction[];
  loading?: boolean;
}

export const Actions = memo(
  (props: ActionsProps) => {
    const {
      query,
      model,
      setModel,
      handleSendMessage,
      customActions,
      className,
      loading,
      runtimeConfig,
      setRuntimeConfig,
    } = props;
    const { t } = useTranslation();

    // hooks
    const isWeb = getRuntime() === 'web';

    const userStore = useUserStoreShallow((state) => ({
      isLogin: state.isLogin,
    }));
    const { isPilotActivated, setIsPilotActivated } = useChatStoreShallow((state) => ({
      isPilotActivated: state.isPilotActivated,
      setIsPilotActivated: state.setIsPilotActivated,
    }));

    const canSendEmptyMessage = useMemo(() => query?.trim(), [query]);
    const canSendMessage = useMemo(
      () => !userStore.isLogin || canSendEmptyMessage,
      [userStore.isLogin, canSendEmptyMessage],
    );

    const detectedUrls = useMemo(() => {
      if (!query?.trim()) return [];
      const { detectedUrls } = extractUrlsWithLinkify(query);
      return detectedUrls;
    }, [query]);

    // Handle switch change
    const handleAutoParseLinksChange = useCallback(
      (checked: boolean) => {
        setRuntimeConfig({
          ...runtimeConfig,
          disableLinkParsing: checked,
        });
      },
      [runtimeConfig, setRuntimeConfig],
    );

    // Create a pilot session or directly send message
    const handleSend = useCallback(() => {
      if (!canSendMessage) return;
      handleSendMessage();
    }, [canSendMessage, handleSendMessage]);

    const containerRef = useRef<HTMLDivElement>(null);

    return (
      <div className={cn('flex justify-between items-center', className)} ref={containerRef}>
        <div className="flex items-center">
          <div className="mr-2">
            <Segmented
              size="small"
              value={isPilotActivated ? 'agent' : 'ask'}
              onChange={(value) => setIsPilotActivated(value === 'agent')}
              options={[
                {
                  label: (
                    <Tooltip title={t('mode.askDescription')}>
                      <div className="flex items-center gap-1.5">
                        <IconAskAI className="text-sm" />
                        <span className="text-xs">{t('mode.ask')}</span>
                      </div>
                    </Tooltip>
                  ),
                  value: 'ask',
                },
                {
                  label: (
                    <Tooltip title={t('mode.agentDescription')}>
                      <div className="flex items-center gap-1.5">
                        <IconPilot className="text-sm" />
                        <span className="text-xs">{t('mode.agent')}</span>
                      </div>
                    </Tooltip>
                  ),
                  value: 'agent',
                },
              ]}
            />
          </div>

          {userStore.isLogin && !isPilotActivated && (
            <ModelSelector
              model={model}
              setModel={setModel}
              briefMode={false}
              trigger={['click']}
            />
          )}

          {detectedUrls?.length > 0 && (
            <div className="flex items-center gap-1 ml-2">
              <Switch
                size="small"
                checked={runtimeConfig?.disableLinkParsing}
                onChange={handleAutoParseLinksChange}
              />
              <Tooltip
                className="flex flex-row items-center gap-1 cursor-pointer"
                title={t('skill.runtimeConfig.parseLinksHint', {
                  count: detectedUrls?.length,
                })}
              >
                <LinkOutlined className="text-sm text-gray-500 flex items-center justify-center cursor-pointer" />
              </Tooltip>
            </div>
          )}
        </div>
        <div className="flex flex-row items-center gap-2">
          {customActions?.map((action, index) => (
            <Tooltip title={action.title} key={index}>
              <Button size="small" icon={action.icon} onClick={action.onClick} className="mr-0">
                <span className="text-xs">{action?.content || ''}</span>
              </Button>
            </Tooltip>
          ))}

          {!isWeb ? null : (
            <Button
              size="small"
              type="primary"
              disabled={!canSendMessage}
              className="text-xs flex items-center gap-1"
              onClick={handleSend}
              loading={loading}
            >
              <SendOutlined />
              <span>{t('copilot.chatActions.send')}</span>
            </Button>
          )}
        </div>
      </div>
    );
  },
  (prevProps, nextProps) => {
    return (
      prevProps.handleSendMessage === nextProps.handleSendMessage &&
      prevProps.handleAbort === nextProps.handleAbort &&
      prevProps.query === nextProps.query &&
      prevProps.runtimeConfig === nextProps.runtimeConfig &&
      prevProps.setRuntimeConfig === nextProps.setRuntimeConfig &&
      prevProps.model === nextProps.model
    );
  },
);

Actions.displayName = 'Actions';
