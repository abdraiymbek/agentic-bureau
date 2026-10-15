# Purchased parts and the BOM

A bought part counts only when it is recorded as a component with a source and an observed offer. Prices that exist only in your answer are not recorded.

1. Open the exact seller product page with research_read_page. Check it is the right part and variant, shows a purchase option, and is not a search page, a category, a discontinued listing, a CAPTCHA or an error. If the page is blocked, try another seller; never say a page was checked when you could not read it. Read each page once.
2. Call component_add_candidate with title, manufacturer or vendor, partNumber, description, imageUrl (the real product photo from that page; never a generated image), selectionReason, source {url, title, excerpt} with a factual excerpt (name, price, currency, pack size, availability), and offer {seller, url, price, quantityBasis, availabilityText}. The source is captured in the same call; a sourceId from source_capture also works.
3. In the offer, price is {"amount": "12.50", "currency": "USD"} with amount as a string; quantityBasis is the number of units that price buys. The result returns the saved offer with its id.
4. Engineering values go in properties, each {"quantity": {"value": 55, "unit": "g"}, "sourceId": "..."}. Facts without units go in attributes, each {"value": "PWM"}: an object, never a bare string.
5. When a price or photo cannot be observed, send price null and state what is missing. Do not invent one and do not call the list complete.
6. Add each further seller you actually read with component_add_offer. Offers are separate records.
7. Read back with component_compare: check the name, imageUrl, selectionReason, every offer's price, currency, basis and address. It also returns each offerId.
8. Only when asked for a BOM or a selection: component_propose_selection with the artifactId, bomLines (quantity, offerId, notes) and a reason; the newest draft is proposed, and a line without offerId uses the only offer. Nothing is selected until the human accepts; bom_read shows the approved lines.
9. Read the artifact once more with artifact_read, name any missing data in your answer, then call work_status.
