interface Props {
  onBack: () => void
}

export function Feature2Panel({ onBack }: Props) {
  return (
    <div className="screen-feature2">
      <header className="f2-header rb-drag">
        <button className="gm-back-btn rb-no-drag" onClick={onBack}>
          ← Menu do Jogo
        </button>
        <span className="f2-title">Funcionalidade 2</span>
        <button className="rb-btn-switch rb-no-drag" title="Minimizar" onClick={() => window.electronAPI.minimizeWindow()}>−</button>
        <button className="rb-close rb-no-drag" onClick={() => window.close()}>×</button>
      </header>

      <div className="f2-body rb-no-drag">
        <div className="f2-placeholder">
          <span className="f2-placeholder-icon">🔧</span>
          <span className="f2-placeholder-text">Em desenvolvimento</span>
        </div>
      </div>
    </div>
  )
}
