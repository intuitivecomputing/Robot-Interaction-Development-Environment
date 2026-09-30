const HELP_DOC_URL = "https://docs.google.com/document/d/11AAAL7R7FKhR3Por1AVyXfl5qBn6odfPJ34KEL0uocc/edit?usp=sharing";

export default function HelpButton() {
  return (
    <a
      href={HELP_DOC_URL}
      target="_blank"
      rel="noopener noreferrer"
      title="Help & Instructions"
      className="fixed bottom-24 right-6 z-40 w-12 h-12 rounded-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-lg shadow-lg flex items-center justify-center transition-all hover:scale-105 active:scale-95"
    >
      ?
    </a>
  );
}
