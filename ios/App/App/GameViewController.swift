import UIKit
import WebKit
import Capacitor

// Bridge VC for the game: landscape only, no status bar / home indicator, autoplaying WebAudio.
class GameViewController: CAPBridgeViewController {
    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let config = super.webViewConfiguration(for: instanceConfiguration)
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        return config
    }

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(StorePlugin())   // in-app purchases (StorePlugin.swift)
        webView?.isOpaque = false
        webView?.backgroundColor = UIColor(red: 0x0d / 255, green: 0x10 / 255, blue: 0x20 / 255, alpha: 1)
        webView?.scrollView.bounces = false
        webView?.scrollView.contentInsetAdjustmentBehavior = .never
    }

    override var prefersStatusBarHidden: Bool { true }
    // Swipes at the screen edges go to the game first; a second swipe triggers the system gesture.
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .all }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .landscape }
    override var preferredInterfaceOrientationForPresentation: UIInterfaceOrientation { .landscapeRight }
}
