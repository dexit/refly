import React, { useMemo } from 'react';
import { Button } from 'antd';
import { CloseCircleOutlined, UnorderedListOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { NodeRenderer } from './NodeRenderer';
import { type NodeRelation } from './ArtifactRenderer';
import '../styles/preview-mode.css';
import Logo from '@/assets/logo.svg';

interface PreviewModeProps {
  nodes: NodeRelation[];
  currentSlideIndex: number;
  showPreviewMinimap: boolean;
  uiState: {
    isIdle: boolean;
    showNav: boolean;
  };
  title: string;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  onMouseMove: (e: React.MouseEvent<HTMLDivElement>) => void;
  onSideHintClick: () => void;
  onUiInteraction: () => void;
  onPreviewSlideSelect: (index: number) => void;
  onMinimapMouseEnter: () => void;
  onMinimapMouseLeave: () => void;
  getNodeTitle: (node: NodeRelation) => string;
  previewContentRef: React.RefObject<HTMLDivElement>;
}

const PreviewMode: React.FC<PreviewModeProps> = ({
  nodes,
  currentSlideIndex,
  showPreviewMinimap,
  uiState,
  onClose,
  onMouseMove,
  onSideHintClick,
  onUiInteraction,
  onPreviewSlideSelect,
  onMinimapMouseEnter,
  onMinimapMouseLeave,
  getNodeTitle,
  previewContentRef,
}) => {
  const { t } = useTranslation();

  // Calculate current progress percentage
  const progressPercentage = useMemo(() => {
    if (nodes.length <= 1) return 100;
    return (currentSlideIndex / (nodes.length - 1)) * 100;
  }, [currentSlideIndex, nodes.length]);

  return (
    <div
      ref={previewContentRef}
      className={`preview-content-container relative ${uiState.isIdle ? 'idle' : ''} ${uiState.showNav ? 'show-nav' : ''}`}
      onMouseMove={onMouseMove}
    >
      {/* Top progress bar */}
      <div
        className="preview-progress-bar"
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: `${progressPercentage}%`,
          height: '2px',
          background: 'linear-gradient(to right, #108ee9, #1890ff)',
          borderRadius: '0 2px 2px 0',
          boxShadow: '0 0 6px rgba(24, 144, 255, 0.5)',
          transition: 'width 0.4s cubic-bezier(0.23, 1, 0.32, 1)',
          zIndex: 1000,
        }}
      />

      {/* Preview navigation bar - only keep the close button in the top right corner */}
      <div
        className={`preview-close-button ${uiState.isIdle ? 'opacity-0' : 'opacity-100'}`}
        onMouseEnter={onUiInteraction}
        style={{
          position: 'absolute',
          top: '16px',
          right: '16px',
          zIndex: 50,
          transition: 'opacity 0.3s ease-out',
        }}
      >
        <Button
          type="text"
          icon={<CloseCircleOutlined style={{ fontSize: '24px' }} />}
          onClick={onClose}
          className="preview-control-button close-button"
          style={{
            background: 'rgba(0, 0, 0, 0.2)',
            borderRadius: '50%',
            width: '40px',
            height: '40px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'white',
            border: 'none',
          }}
        />
      </div>

      {/* Side hint - displayed when the minimap is hidden */}
      {!showPreviewMinimap && nodes.length > 1 && (
        <div className="side-hint" onClick={onSideHintClick}>
          <UnorderedListOutlined />
        </div>
      )}

      {/* Preview mode minimap */}
      <div
        className={`preview-minimap ${showPreviewMinimap ? 'preview-minimap-show' : ''}`}
        onMouseEnter={onMinimapMouseEnter}
        onMouseLeave={onMinimapMouseLeave}
      >
        <div className="preview-minimap-header">{t('pages.components.navigationDirectory')}</div>
        <div className="preview-minimap-content">
          {nodes.map((node, index) => (
            <div
              key={`minimap-slide-${index}`}
              className={`preview-minimap-slide ${currentSlideIndex === index ? 'active' : ''}`}
              onClick={() => onPreviewSlideSelect(index)}
            >
              <div className="preview-minimap-number">{index + 1}</div>
              <div className="preview-minimap-thumbnail">
                <div
                  style={{
                    height: '100%',
                    overflow: 'hidden',
                    transform: 'scale(0.95)',
                    background: '#fff',
                    pointerEvents: 'none',
                    userSelect: 'none',
                  }}
                >
                  <NodeRenderer node={node} isFullscreen={false} isModal={true} isMinimap={true} />
                </div>
                {/* Transparent mask layer */}
                <div className="absolute inset-0 bg-transparent" />
              </div>
              <div className="preview-minimap-title">{getNodeTitle(node)}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Main preview content */}
      <div className="preview-content">
        <div
          className="w-full h-full preview-slide"
          style={{
            animationName: 'slideIn',
            animationDuration: '0.5s',
            animationTimingFunction: 'ease-out',
            animationFillMode: 'forwards',
          }}
        >
          <NodeRenderer node={nodes[currentSlideIndex]} isFullscreen={true} isModal={true} />
        </div>
      </div>

      {/* Swipe hint - only displayed on mobile devices */}
      {nodes.length > 1 && (
        <div className="swipe-hint md:hidden">
          {t('pages.components.swipeHint', { current: currentSlideIndex + 1, total: nodes.length })}
        </div>
      )}

      {/* Preview mode footer progress indicator */}
      {nodes.length > 1 && (
        <div
          className={`preview-footer ${uiState.isIdle ? 'opacity-0' : 'opacity-100'}`}
          onMouseEnter={onUiInteraction}
          style={{ transition: 'opacity 0.3s ease-out' }}
        >
          <div className="dots-container">
            {nodes.map((_, index) => (
              <div
                key={`preview-dot-${index}`}
                className={`preview-dot ${index === currentSlideIndex ? 'active' : ''}`}
                onClick={() => onPreviewSlideSelect(index)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Refly Logo in bottom right corner */}
      <div
        className="fixed bottom-4 right-4 z-40 opacity-80 hover:opacity-100 cursor-pointer transition-all duration-300 hover:scale-105 transform-gpu"
        onClick={() => window.open('/', '_blank')}
        style={{
          filter: 'drop-shadow(0 0 4px rgba(0, 0, 0, 0.2))',
          backdropFilter: 'blur(2px)',
          background: 'rgba(255, 255, 255, 0.15)',
          borderRadius: '30px',
          padding: '5px 10px',
          border: '1px solid rgba(255, 255, 255, 0.2)',
        }}
      >
        <div className="flex items-center gap-2">
          <img
            src={Logo}
            alt="Refly"
            className="h-6 w-6"
            style={{ filter: 'saturate(1.2) brightness(1.05)' }}
          />
          <span
            className="text-sm font-bold"
            translate="no"
            style={{
              color: '#333',
              textShadow: '0 1px 1px rgba(255, 255, 255, 0.5)',
            }}
          >
            AI Canvas
          </span>
        </div>
      </div>
    </div>
  );
};

export default PreviewMode;
