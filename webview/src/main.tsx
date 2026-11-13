import { createRoot } from "react-dom/client";
import { WorkbookApp } from "./WorkbookApp";
import "./page.css";
import "./style.css";
import "./workbook.css";
import "./workbook-grid.css";
import "./feature-panels.css";
import "./ribbon.css";
import "./tablet.css";

createRoot(document.getElementById("root")!).render(<WorkbookApp />);
