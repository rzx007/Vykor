import { RouterProvider } from "@tanstack/react-router"

import { router } from "@renderer/router"
import { ImageViewerProvider } from "@renderer/components/desktop/image-viewer/image-viewer-provider"

function App(): React.JSX.Element {
  return (
    <ImageViewerProvider>
      <RouterProvider router={router} />
    </ImageViewerProvider>
  )
}

export default App
