import React, { memo, useCallback, useMemo } from 'react';
import { Input, Button, Radio } from 'antd';
import { SendOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { IconImage } from '@refly-packages/ai-workspace-common/components/common/icon';
import { HiOutlineFilm, HiOutlineSpeakerWave } from 'react-icons/hi2';
import { useAddNode } from '@refly-packages/ai-workspace-common/hooks/canvas/use-add-node';
import { genImageID, genVideoID, genAudioID } from '@refly/utils/id';
import { useReactFlow } from '@xyflow/react';

const { TextArea } = Input;

interface MediaChatInputProps {
  readonly: boolean;
  query: string;
  setQuery: (value: string) => void;
  mediaType: 'image' | 'video' | 'audio';
  setMediaType: (type: 'image' | 'video' | 'audio') => void;
  nodeId: string;
  onSend?: () => void;
}

const MediaChatInput = memo(
  ({ readonly, query, setQuery, mediaType, setMediaType, nodeId, onSend }: MediaChatInputProps) => {
    const { t } = useTranslation();
    const { addNode } = useAddNode();
    const { getNode } = useReactFlow();

    const mediaOptions = useMemo(() => {
      return [
        {
          value: 'image',
          label: t('canvas.nodes.mediaSkill.image', 'Image'),
          icon: IconImage,
        },
        {
          value: 'video',
          label: t('canvas.nodes.mediaSkill.video', 'Video'),
          icon: HiOutlineFilm,
        },
        {
          value: 'audio',
          label: t('canvas.nodes.mediaSkill.audio', 'Audio'),
          icon: HiOutlineSpeakerWave,
        },
      ];
    }, [t]);

    const getPlaceholder = useCallback(() => {
      switch (mediaType) {
        case 'image':
          return t(
            'canvas.nodes.mediaSkill.imagePlaceholder',
            'Describe the image you want to generate...',
          );
        case 'video':
          return t(
            'canvas.nodes.mediaSkill.videoPlaceholder',
            'Describe the video you want to generate...',
          );
        case 'audio':
          return t(
            'canvas.nodes.mediaSkill.audioPlaceholder',
            'Describe the audio you want to generate...',
          );
        default:
          return t(
            'canvas.nodes.mediaSkill.defaultPlaceholder',
            'Describe what you want to generate...',
          );
      }
    }, [mediaType, t]);

    const handleSend = useCallback(() => {
      if (!query?.trim()) return;

      // Get current node position
      const currentNode = getNode(nodeId);
      if (!currentNode) return;

      // Calculate position for new node (to the right of current node)
      const newPosition = {
        x: currentNode.position.x + (currentNode.measured?.width || 384) + 100,
        y: currentNode.position.y,
      };

      // Create appropriate node based on mediaType
      if (mediaType === 'image') {
        addNode(
          {
            type: 'image',
            data: {
              title: query,
              entityId: genImageID(),
              metadata: {
                imageUrl:
                  'http://localhost:5800/v1/misc/static/311d2610-360e-46b9-811a-6a63f339e8da.jpg',
                storageKey: 'static/311d2610-360e-46b9-811a-6a63f339e8da.jpg',
              },
            },
            position: newPosition,
          },
          [
            {
              type: 'mediaSkill',
              entityId: currentNode.data?.entityId as string,
              handleType: 'source',
            },
          ],
          false,
          true,
        );
      } else if (mediaType === 'video') {
        addNode(
          {
            type: 'video',
            data: {
              title: query,
              entityId: genVideoID(),
              metadata: {
                videoUrl:
                  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
                storageKey: 'static/311d2610-360e-46b9-811a-6a63f339e8da.jpg',
              },
            },
            position: newPosition,
          },
          [
            {
              type: 'mediaSkill',
              entityId: currentNode.data?.entityId as string,
              handleType: 'source',
            },
          ],
          false,
          true,
        );
      } else if (mediaType === 'audio') {
        addNode(
          {
            type: 'audio',
            data: {
              title: query,
              entityId: genAudioID(),
              metadata: {
                audioUrl: 'https://www.soundjay.com/misc/sounds/bell-ringing-05.wav',
                storageKey: 'static/311d2610-360e-46b9-811a-6a63f339e8da.jpg',
              },
            },
            position: newPosition,
          },
          [
            {
              type: 'mediaSkill',
              entityId: currentNode.data?.entityId as string,
              handleType: 'source',
            },
          ],
          false,
          true,
        );
      }

      // Clear query
      setQuery('');

      // Call optional onSend callback
      onSend?.();
    }, [query, mediaType, nodeId, getNode, addNode, setQuery, onSend]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (readonly) {
          e.preventDefault();
          return;
        }

        // Handle Enter key
        if (e.key === 'Enter') {
          // Shift + Enter creates a new line
          if (e.shiftKey) {
            return;
          }

          // Ctrl/Meta + Enter or plain Enter sends message
          if (e.ctrlKey || e.metaKey || !e.shiftKey) {
            e.preventDefault();
            handleSend();
          }
        }
      },
      [readonly, handleSend],
    );

    return (
      <div className="flex flex-grow flex-col justify-between gap-3">
        {/* Media Type Selector */}
        <Radio.Group
          value={mediaType}
          onChange={(e) => setMediaType(e.target.value)}
          className="flex gap-4"
          disabled={readonly}
        >
          {mediaOptions.map((option) => {
            const Icon = option.icon;
            return (
              <Radio.Button
                key={option.value}
                value={option.value}
                className="flex items-center gap-2 px-3 py-1 border border-gray-200 dark:border-gray-600 rounded-lg hover:border-green-300 dark:hover:border-green-400 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Icon className="w-4 h-4" />
                  <span className="text-sm">{option.label}</span>
                </div>
              </Radio.Button>
            );
          })}
        </Radio.Group>

        {/* Input Area */}
        <div className="flex flex-col gap-2">
          <TextArea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={getPlaceholder()}
            disabled={readonly}
            rows={3}
            className="flex-1 resize-none"
            onKeyDown={handleKeyDown}
          />
          <Button
            size="small"
            type="primary"
            icon={<SendOutlined />}
            onClick={handleSend}
            disabled={readonly || !query?.trim()}
            className="self-end"
          >
            {t('common.send', 'Send')}
          </Button>
        </div>
      </div>
    );
  },
);

MediaChatInput.displayName = 'MediaChatInput';

export { MediaChatInput };
