# world
### ITEM
- name
- barcode
- batch number (maybe referenced by stock)
- manufacturer
- type
- price per strip/package	
- discount
- total price (derrived)
#### Drugs (type: drug)
	- drug type
	- perscription? (bool) (otc if not)
	- active pharmatical ingredient(s) (multivalued) (in the table, include strength)
	- physical type (tablet, liquid, ...)
	- procedural specifications (oral, topical, iv, im, ...)
	- number of strips in a package
	- main stock count 

### stock
- items (refrenced by barcode)
- batch number
- count

### client
- name (composite if needed)
- phone (multivalued)

### staff 
- name (composite if needed)
- phone (multivalued)
- role
- date of birth
- salary
- start date
- day shift
- works at branch (relation)

### Suppliers
- name (composite if needed)
- phone (multivalued)
- partner name (company)
- supply origin (egyptian, chinese, russian, ...)

### branch
- name
- phone (multivalued)
- address
- stock for each item (many to many table)
- managed by? (relation)

### order
- client
- date, time
- items (refrenced by barcode)
- price (derrived)
- payment method
- payment info (null if cash, last 4 numbers of visa, phone number if paid by any phone wallet/instapay)

### stock payment order
- supplier
- date, time
- items (refrenced by barcode), batch numbers
- price (derrived)
