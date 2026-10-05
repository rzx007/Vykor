import { useState } from "react"
import { createRoot } from "react-dom/client"
function Page() {
  const [count, setCount] = useState(0)
  return <main style={{ padding: 24, fontFamily: "system-ui" }}><button id="target" style={{ padding: 12 }} onClick={() => setCount(count + 1)}>提交</button><p>页面按钮执行次数：{count}</p></main>
}
createRoot(document.getElementById("root")!).render(<Page />)
