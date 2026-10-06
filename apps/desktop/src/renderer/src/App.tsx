import { RouterProvider } from "@tanstack/react-router"

import { router } from "@renderer/router"

function App(): React.JSX.Element {
  return <RouterProvider router={router} />
}

export default App
