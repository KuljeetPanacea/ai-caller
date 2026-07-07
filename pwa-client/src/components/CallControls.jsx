export default function CallControls({ children, variant = 'active' }) {
  return (
    <div className={`call-controls ${variant}`}>
      {children}
    </div>
  )
}
