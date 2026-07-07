export default function CallAction({ icon, label, onClick, className }) {
  return (
    <div>
      <button className={`round-btn ${className}`} onClick={onClick} aria-label={label}>
        {icon}
      </button>
      <p className="icon-label">{label}</p>
    </div>
  )
}
