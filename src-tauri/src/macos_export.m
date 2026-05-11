// macOS PDF export helper.
//
// WKWebView's createPDFWithConfiguration:completionHandler: is the only
// crash-safe path to a vector PDF on the current macOS. It captures a
// single rect into a one-page PDF, so to get a paginated A4 document we
// call it once per page rect and stitch the resulting pages with PDFKit.
//
// Returns 0 on success, negative error code otherwise. *err_out (if non-null)
// receives a malloc'd C string describing the failure; caller must free.

#import <WebKit/WebKit.h>
#import <PDFKit/PDFKit.h>
#import <Foundation/Foundation.h>
#import <stdlib.h>
#import <string.h>

static char* copy_err(NSString* msg) {
    if (!msg) return NULL;
    const char* u = [msg UTF8String];
    if (!u) return NULL;
    return strdup(u);
}

// Run the main run loop until *done is true or the deadline passes.
// Returns YES if completed, NO on timeout.
static BOOL pump_until(BOOL* done, NSTimeInterval timeout) {
    NSDate* deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
    while (!*done) {
        if ([[NSDate date] compare:deadline] != NSOrderedAscending) return NO;
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    }
    return YES;
}

int lesepult_export_pdf(
    void* webview_ptr,
    const char* target_path_c,
    double page_width,
    double page_height,
    double total_height,
    char** err_out
) {
    if (err_out) *err_out = NULL;
    if (!webview_ptr || !target_path_c) {
        if (err_out) *err_out = copy_err(@"null argument");
        return -1;
    }
    if (page_width <= 0 || page_height <= 0 || total_height <= 0) {
        if (err_out) *err_out = copy_err(@"invalid dimensions");
        return -2;
    }

    @autoreleasepool {
        id raw = (__bridge id)webview_ptr;
        if (![raw isKindOfClass:[WKWebView class]]) {
            if (err_out) *err_out = copy_err([NSString stringWithFormat:@"not a WKWebView: %@", NSStringFromClass([raw class])]);
            return -3;
        }
        WKWebView* webView = (WKWebView*)raw;
        NSString* targetPath = [NSString stringWithUTF8String:target_path_c];
        NSURL* targetURL = [NSURL fileURLWithPath:targetPath];

        NSUInteger pageCount = (NSUInteger)ceil(total_height / page_height);
        if (pageCount == 0) pageCount = 1;
        // Hard cap so a runaway measurement can't produce thousands of pages.
        if (pageCount > 500) pageCount = 500;

        PDFDocument* outDoc = [[PDFDocument alloc] init];

        for (NSUInteger i = 0; i < pageCount; i++) {
            CGRect rect = CGRectMake(0,
                                     (CGFloat)(i * page_height),
                                     (CGFloat)page_width,
                                     (CGFloat)page_height);

            WKPDFConfiguration* config = [[WKPDFConfiguration alloc] init];
            config.rect = rect;

            __block NSData* pageData = nil;
            __block NSString* pageErr = nil;
            __block BOOL pageDone = NO;

            @try {
                [webView createPDFWithConfiguration:config completionHandler:^(NSData* data, NSError* error) {
                    if (error) pageErr = [error localizedDescription];
                    else pageData = data;
                    pageDone = YES;
                }];
            } @catch (NSException* ex) {
                if (err_out) *err_out = copy_err([NSString stringWithFormat:@"createPDF threw on page %lu: %@", (unsigned long)i, [ex reason] ?: [ex name]]);
                return -4;
            }

            if (!pump_until(&pageDone, 30.0)) {
                if (err_out) *err_out = copy_err([NSString stringWithFormat:@"createPDF timed out on page %lu", (unsigned long)i]);
                return -5;
            }
            if (pageErr) {
                if (err_out) *err_out = copy_err([NSString stringWithFormat:@"page %lu: %@", (unsigned long)i, pageErr]);
                return -6;
            }
            if (!pageData) {
                if (err_out) *err_out = copy_err([NSString stringWithFormat:@"page %lu: nil data", (unsigned long)i]);
                return -7;
            }

            PDFDocument* singlePage = [[PDFDocument alloc] initWithData:pageData];
            if (!singlePage || [singlePage pageCount] == 0) {
                if (err_out) *err_out = copy_err([NSString stringWithFormat:@"page %lu: could not parse PDF data", (unsigned long)i]);
                return -8;
            }
            PDFPage* page = [singlePage pageAtIndex:0];
            [outDoc insertPage:page atIndex:[outDoc pageCount]];
        }

        if ([outDoc pageCount] == 0) {
            if (err_out) *err_out = copy_err(@"no pages produced");
            return -9;
        }

        BOOL ok = [outDoc writeToURL:targetURL];
        if (!ok) {
            if (err_out) *err_out = copy_err(@"PDFDocument writeToURL failed");
            return -10;
        }
        return 0;
    }
}
